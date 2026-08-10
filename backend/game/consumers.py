"""
WebSocket-слой.

Важно: состояние рассылается КАЖДОМУ ИГРОКУ ПЕРСОНАЛЬНО, потому что рука
видна только своему владельцу. Поэтому вместо одного broadcast'а на группу
мы шлём индивидуальный пакет в канал каждого игрока.
"""

from __future__ import annotations

import asyncio
import json
import time
from urllib.parse import parse_qs

from channels.generic.websocket import AsyncWebsocketConsumer

# Балансировщики и прокси рвут соединения без активности.
# При игре между странами трафик всегда идёт через них, поэтому
# держим канал живым регулярными пингами.
KEEPALIVE_SECONDS = 25

from .durak_engine import IllegalMove, Phase
from .rooms import parse_card, registry


class RoomConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.code = self.scope["url_route"]["kwargs"]["code"].upper()
        params = parse_qs(self.scope["query_string"].decode())

        self.player_name = (params.get("name", [""])[0] or "").strip()[:20]
        self.char_id = (params.get("char", ["jack"])[0] or "jack")[:20]
        max_players = int(params.get("max", ["4"])[0] or 4)
        translatable = params.get("translatable", ["1"])[0] != "0"
        pair_defense = params.get("pair", ["0"])[0] == "1"

        if not self.player_name:
            await self.close(code=4001)
            return

        self.group = f"room_{self.code}"
        self.room = registry.get_or_create(
            self.code,
            host_name=self.player_name,
            max_players=max_players,
            translatable=translatable,
            pair_defense=pair_defense,
        )

        await self.accept()

        try:
            seat = self.room.join(self.player_name, self.char_id, self.channel_name)
        except IllegalMove as e:
            await self.send_json({"type": "error", "message": str(e), "fatal": True})
            await self.close(code=4002)
            return

        self.pid = seat.pid
        await self.channel_layer.group_add(self.group, self.channel_name)

        self.room.last_event = {"kind": "join", "name": self.player_name}
        self._keepalive = asyncio.create_task(self._keepalive_loop())
        await self.broadcast_state()

    async def _keepalive_loop(self):
        try:
            while True:
                await asyncio.sleep(KEEPALIVE_SECONDS)
                await self.send_json({"type": "ping", "t": int(time.time() * 1000)})
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            pass

    async def disconnect(self, code):
        task = getattr(self, "_keepalive", None)
        if task:
            task.cancel()
        room = registry.get(self.code)
        if not room or not hasattr(self, "pid"):
            return
        room.leave(self.pid)
        room.last_event = {"kind": "leave", "name": self.player_name}
        await self.channel_layer.group_discard(self.group, self.channel_name)
        await self.broadcast_state()
        registry.drop_if_empty(self.code)

    # ---------- Приём действий ----------

    async def receive(self, text_data=None, bytes_data=None):
        try:
            data = json.loads(text_data or "{}")
        except json.JSONDecodeError:
            await self.send_json({"type": "error", "message": "Некорректный запрос"})
            return

        action = data.get("action")
        room = registry.get(self.code)
        if room is None:
            await self.send_json({"type": "error", "message": "Комната не найдена"})
            return

        try:
            await self.handle_action(room, action, data)
        except IllegalMove as e:
            # Ошибка правил — личное сообщение только этому игроку,
            # остальным незачем видеть чужие неудачные попытки.
            await self.send_json({"type": "error", "message": str(e)})
            return
        except Exception as e:  # noqa: BLE001
            await self.send_json({"type": "error", "message": f"Ошибка сервера: {e}"})
            return

        await self.broadcast_state()

    async def handle_action(self, room, action: str, data: dict) -> None:
        if action == "start":
            room.start_game(self.player_name)
            room.last_event = {"kind": "start"}
            return

        if action == "restart":
            room.restart_game()
            room.last_event = {"kind": "restart"}
            return

        if action in ("ping", "pong"):
            # клиент подтвердил, что жив — замеряем задержку
            sent = data.get("t")
            if sent:
                await self.send_json({"type": "latency", "ms": int(time.time() * 1000) - int(sent)})
            return

        game = room.game
        if game is None:
            raise IllegalMove("Партия ещё не началась")

        if action == "attack":
            card = parse_card(data.get("card"))
            game.attack_with(self.pid, card)
            room.last_event = {"kind": "attack", "by": self.player_name, "card": card.to_dict()}

        elif action == "defend":
            card = parse_card(data.get("card"))
            slot_index = int(data.get("slot", 0))
            game.defend_with(self.pid, slot_index, card)
            room.last_event = {"kind": "defend", "by": self.player_name, "card": card.to_dict()}

        elif action == "translate":
            card = parse_card(data.get("card"))
            game.translate(self.pid, card)
            room.last_event = {"kind": "translate", "by": self.player_name, "card": card.to_dict()}

        elif action == "show_trump":
            card = parse_card(data.get("card"))
            shown = game.show_trump_translate(self.pid, card)
            room.last_event = {
                "kind": "show_trump",
                "by": self.player_name,
                "card": shown["card"],
            }

        elif action == "take":
            game.take(self.pid)
            room.last_event = {"kind": "take", "by": self.player_name}

        elif action == "ready":
            game.pass_turn(self.pid)
            room.last_event = {"kind": "ready", "by": self.player_name}

        elif action == "unready":
            game.unpass(self.pid)
            room.last_event = {"kind": "unready", "by": self.player_name}

        elif action == "resolve":
            game.resolve_bout()
            room.last_event = {"kind": "resolve"}

        else:
            raise IllegalMove(f"Неизвестное действие: {action}")

        self.maybe_auto_resolve(room)

    def maybe_auto_resolve(self, room) -> None:
        """
        Заход закрывается сам, когда:
          * защищающийся взял карты, и подкидывать больше некому/нечего, либо
          * всё отбито и все включили движок готовности.
        """
        game = room.game
        if game is None or game.phase is not Phase.ATTACK or not game.table:
            return

        if game.defender_took:
            if game.everyone_passed() or not any(
                game.legal_throw_ins(p.pid) for p in game.throwers()
            ):
                taker = game.defender.pid
                taker_name = game.defender.name
                game.resolve_bout()
                room.last_event = {
                    "kind": "bout_over",
                    "took": True,
                    "taker": taker,
                    "taker_name": taker_name,
                }
                result = room.record_result()
                if result:
                    room.last_event = {"kind": "game_over", **result}
            return

        if game.all_beaten() and game.everyone_passed():
            took = game.defender_took
            taker = game.defender.pid
            taker_name = game.defender.name
            game.resolve_bout()
            room.last_event = {
                "kind": "bout_over",
                "took": took,
                "taker": taker if took else None,
                "taker_name": taker_name if took else None,
            }

        # исход мог стать очевидным ещё до конца захода — не заставляем ждать
        if game.phase is Phase.ATTACK:
            forced = game.force_finish()
            if forced:
                room.last_event = {"kind": "forced_end", "loser": forced.name}

        # партия могла завершиться — фиксируем результат и вешаем погон
        result = room.record_result()
        if result:
            room.last_event = {"kind": "game_over", **result}

    # ---------- Рассылка ----------

    async def broadcast_state(self) -> None:
        """Просим каждого участника группы отправить себе свой личный срез состояния."""
        await self.channel_layer.group_send(self.group, {"type": "push_state"})

    async def push_state(self, event) -> None:
        room = registry.get(self.code)
        if room is None:
            return
        pid = getattr(self, "pid", None)
        await self.send_json(room.state_for(pid))

    async def send_json(self, payload: dict) -> None:
        await self.send(text_data=json.dumps(payload, ensure_ascii=False))
