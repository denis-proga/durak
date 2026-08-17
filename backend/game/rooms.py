"""
Реестр комнат в памяти процесса.

Несколько компаний могут играть одновременно: каждая комната — отдельный объект
со своим состоянием игры, полностью изолированный от остальных.

Переподключение сделано ПО ИМЕНИ: если человек потерял связь и зашёл снова
с тем же ником, он занимает своё старое место со своими картами.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Optional

from .durak_engine import Card, DurakGame, IllegalMove

# ============ ПОГОНЫ ============
# Правила (как играют вживую):
#   * погон цепляется ТОЛЬКО в финале партии, и только один за партию;
#   * получает его тот, кто ЗАБРАЛ последние карты и остался дураком;
#   * лестница строгая и ПЕРСОНАЛЬНАЯ: 6 → 7 → 8 → 9 → 10 → В → Д → К → Т → дама пик.
#     Подцепил 6 — тебе нужна 7, а остальным всё ещё 6;
#   * положили не ту ступень — ничего не происходит;
#   * полный комплект из четырёх карт нужной ступени пропускает следующую;
#   * одной козырной карты мало — нужна хотя бы одна некозырная того же достоинства.

LADDER = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"]
QUEEN_OF_SPADES = ("Q", "♠")

RANK_TITLES = [
    "Чистый погон",      # 0
    "Ефрейтор",          # 1 — 6
    "Младший сержант",   # 2 — 7
    "Сержант",           # 3 — 8
    "Старший сержант",   # 4 — 9
    "Старшина",          # 5 — 10
    "Прапорщик",         # 6 — В
    "Лейтенант",         # 7 — Д
    "Капитан",           # 8 — К
    "Полковник",         # 9 — Т
    "Генерал",           # 10 — дама пик, выше некуда
]
MAX_LEVEL = 10


def needed_step(level: int) -> Optional[str]:
    """Какую карту игроку нужно подцепить следующей."""
    if level >= MAX_LEVEL:
        return None
    if level == len(LADDER):  # все ступени пройдены — остаётся дама пик
        return "Q♠"
    return LADDER[level]


def epaulette_for(level: int) -> dict:
    """Описание текущего звания игрока."""
    level = max(0, min(level, MAX_LEVEL))
    if level == 0:
        card = None
    elif level == MAX_LEVEL:
        card = "Q♠"
    else:
        card = LADDER[level - 1]
    return {
        "level": level,
        "card": card,
        "rank": RANK_TITLES[level],
        "next": needed_step(level),
    }


def evaluate_epaulette(level: int, taken: list, trump_suit: str) -> Optional[dict]:
    """
    Смотрит, заслужил ли проигравший погон этими картами.
    Возвращает описание нового звания либо None, если ступень не совпала.
    """
    if level >= MAX_LEVEL:
        return None

    # Финальная ступень — нужна именно дама пик, козырное правило тут не действует
    if level == len(LADDER):
        if any(c.rank == QUEEN_OF_SPADES[0] and c.suit == QUEEN_OF_SPADES[1] for c in taken):
            return {"new_level": MAX_LEVEL, "matched": ["Q♠"], "skipped": False}
        return None

    need = LADDER[level]
    matching = [c for c in taken if c.rank == need]
    if not matching:
        return None

    # Одной козырной мало — нужна хотя бы одна обычная того же достоинства
    if not any(c.suit != trump_suit for c in matching):
        return None

    # Полный комплект из четырёх пропускает следующую ступень
    full_set = len(matching) >= 4
    new_level = level + (2 if full_set else 1)
    new_level = min(new_level, len(LADDER))

    return {
        "new_level": new_level,
        "matched": [str(c) for c in matching],
        "skipped": full_set,
    }


@dataclass
class Seat:
    pid: str          # стабильный идентификатор места
    name: str         # ник игрока
    char_id: str      # выбранный персонаж
    connected: bool = True
    channel: Optional[str] = None  # имя канала WebSocket
    disconnected_at: Optional[float] = None  # когда пропала связь


@dataclass
class Room:
    code: str
    host_name: str
    max_players: int = 4
    translatable: bool = True
    pair_defense: bool = False
    seats: list[Seat] = field(default_factory=list)
    game: Optional[DurakGame] = None
    last_event: Optional[dict] = None
    # Статистика сессии. Ключи — ники, чтобы данные пережили переподключения.
    losses: dict[str, int] = field(default_factory=dict)
    levels: dict[str, int] = field(default_factory=dict)  # ступень лестницы погонов
    games_played: int = 0
    result_recorded: bool = False
    # Проигравший прошлой партии — по правилам следующую он открывает сам.
    last_loser_name: Optional[str] = None

    # ---------- Лобби ----------

    def seat_by_name(self, name: str) -> Optional[Seat]:
        lowered = name.strip().lower()
        return next((s for s in self.seats if s.name.strip().lower() == lowered), None)

    def seat_by_pid(self, pid: str) -> Optional[Seat]:
        return next((s for s in self.seats if s.pid == pid), None)

    def join(self, name: str, char_id: str, channel: str) -> Seat:
        """Занять место или вернуться на своё после обрыва связи."""
        existing = self.seat_by_name(name)
        if existing:
            existing.connected = True
            existing.channel = channel
            existing.disconnected_at = None
            if self.game:
                self.game.set_connected(existing.pid, True)
            return existing

        if self.game is not None:
            raise IllegalMove("Партия уже идёт — дождитесь её окончания")
        if len(self.seats) >= self.max_players:
            raise IllegalMove("В комнате нет свободных мест")

        seat = Seat(pid=f"seat{len(self.seats)}", name=name, char_id=char_id, channel=channel)
        self.seats.append(seat)
        return seat

    def leave(self, pid: str) -> None:
        seat = self.seat_by_pid(pid)
        if not seat:
            return
        seat.connected = False
        seat.channel = None
        seat.disconnected_at = time.time()
        if self.game:
            # партия ставится на паузу — место сохраняется за игроком
            self.game.set_connected(pid, False)
        else:
            # игра ещё не началась — просто освобождаем место
            self.seats = [s for s in self.seats if s.pid != pid]

    @property
    def is_empty(self) -> bool:
        return not any(s.connected for s in self.seats)

    @property
    def can_start(self) -> bool:
        return self.game is None and 2 <= len(self.seats) <= 6

    # ---------- Партия ----------

    def start_game(self, by_name: str) -> None:
        if self.game is not None:
            raise IllegalMove("Партия уже начата")
        if by_name.strip().lower() != self.host_name.strip().lower():
            raise IllegalMove("Начать партию может только создатель комнаты")
        if len(self.seats) < 2:
            raise IllegalMove("Нужно минимум 2 игрока")

        self.result_recorded = False
        self.game = DurakGame(
            players=[(s.pid, s.name) for s in self.seats],
            translatable=self.translatable,
            pair_defense=self.pair_defense,
            forced_first_defender=self._resolve_forced_defender(),
        )

    def restart_game(self) -> None:
        """Новая партия тем же составом — например, если кто-то ушёл насовсем."""
        alive = [s for s in self.seats if s.connected]
        if len(alive) < 2:
            raise IllegalMove("Для новой партии нужно минимум 2 игрока на связи")
        self.seats = alive
        for i, s in enumerate(self.seats):
            s.pid = f"seat{i}"
        self.result_recorded = False
        self.game = DurakGame(
            players=[(s.pid, s.name) for s in self.seats],
            translatable=self.translatable,
            pair_defense=self.pair_defense,
            forced_first_defender=self._resolve_forced_defender(),
        )

    def _resolve_forced_defender(self) -> Optional[str]:
        """
        pid проигравшего прошлую партию — по правилам он «ходит на дурака»,
        то есть ЗАЩИЩАЕТСЯ первым в новой партии. Если его уже нет за столом,
        играем обычным порядком (младший козырь).
        """
        if not self.last_loser_name:
            return None
        seat = self.seat_by_name(self.last_loser_name)
        return seat.pid if seat else None

    # ---------- Статистика и погоны ----------

    def record_result(self) -> Optional[dict]:
        """
        Итог партии. Проигрыш засчитывается всегда, а погон — только если
        забранные в финале карты совпали с нужной ступенью лестницы.
        """
        if self.game is None or self.result_recorded:
            return None
        if self.game.phase.value != "finished":
            return None

        self.result_recorded = True
        self.games_played += 1

        loser = self.game.loser
        if loser is None:
            return {"draw": True}

        seat = self.seat_by_pid(loser.pid)
        name = seat.name if seat else loser.name
        self.losses[name] = self.losses.get(name, 0) + 1
        self.last_loser_name = name

        result = {
            "loser": name,
            "losses": self.losses[name],
            "epaulette_awarded": False,
        }

        # Погон вешается только на того, кто ЗАБРАЛ последние карты
        taken_info = self.game.last_taken
        if not taken_info or taken_info[0] != loser.pid:
            result["reason"] = "Погон не засчитан — карты в финале не были забраны"
            result.update(epaulette_for(self.levels.get(name, 0)))
            return result

        # Заход должен быть "чистым": если проигравший уже успел что-то
        # отбить в этом же заходе (в т.ч. собственным козырем), а потом
        # добрал остаток — это смешанный заход. Правило по-дворовому:
        # твоя удачная защита не должна задним числом стать погоном,
        # даже если карта физически вернулась к тебе в руку при взятии.
        if not self.game.last_taken_clean:
            level = self.levels.get(name, 0)
            result["reason"] = (
                "Погон не засчитан — в этом заходе ты уже успел отбиться, "
                "а взял лишь остаток (например, вернул свой же козырь)"
            )
            result.update(epaulette_for(level))
            return result

        level = self.levels.get(name, 0)
        outcome = evaluate_epaulette(level, taken_info[1], self.game.trump_suit)

        if outcome is None:
            need = needed_step(level)
            result["reason"] = (
                f"Погон не засчитан — нужна была карта {need}"
                if need
                else "Выше генерала звания нет"
            )
            result.update(epaulette_for(level))
            return result

        self.levels[name] = outcome["new_level"]
        result["epaulette_awarded"] = True
        result["matched"] = outcome["matched"]
        result["skipped"] = outcome["skipped"]
        result.update(epaulette_for(outcome["new_level"]))
        return result

    def standings(self) -> list[dict]:
        """Таблица сессии: звание каждого и что ему нужно подцепить дальше."""
        rows = []
        for s in self.seats:
            level = self.levels.get(s.name, 0)
            rows.append(
                {
                    "pid": s.pid,
                    "name": s.name,
                    "char_id": s.char_id,
                    "connected": s.connected,
                    "losses": self.losses.get(s.name, 0),
                    **epaulette_for(level),
                }
            )
        # выше по таблице — те, кто меньше «дослужился»
        rows.sort(key=lambda r: (r["level"], r["losses"]))
        return rows

    def waiting_info(self) -> Optional[dict]:
        """
        Сколько ещё ждём отключившихся. При игре между странами связь рвётся
        регулярно, поэтому важно показывать таймер, а не висеть бесконечно.
        """
        gone = [s for s in self.seats if not s.connected and s.disconnected_at]
        if not gone:
            return None
        grace = 120
        try:
            from django.conf import settings as dj_settings

            grace = getattr(dj_settings, "RECONNECT_GRACE_SECONDS", 120)
        except Exception:  # noqa: BLE001
            pass

        oldest = min(s.disconnected_at for s in gone)
        elapsed = time.time() - oldest
        return {
            "names": [s.name for s in gone],
            "seconds_left": max(0, int(grace - elapsed)),
            "expired": elapsed >= grace,
        }

    # ---------- Состояние для клиента ----------

    def state_for(self, pid: Optional[str]) -> dict:
        lobby = {
            "code": self.code,
            "host": self.host_name,
            "max_players": self.max_players,
            "started": self.game is not None,
            "can_start": self.can_start,
            "rules": {
                "translatable": self.translatable,
                "pair_defense": self.pair_defense,
            },
            "seats": [
                {
                    "pid": s.pid,
                    "name": s.name,
                    "char_id": s.char_id,
                    "connected": s.connected,
                }
                for s in self.seats
            ],
            "standings": self.standings(),
            "games_played": self.games_played,
            "waiting": self.waiting_info(),
        }

        if self.game is None:
            return {"type": "state", "in_lobby": True, "lobby": lobby, "game": None, "me": pid}

        game_state = self.game.state_for(pid)
        # подмешиваем выбранных персонажей к игрокам
        char_by_pid = {s.pid: s.char_id for s in self.seats}
        for p in game_state["players"]:
            p["char_id"] = char_by_pid.get(p["pid"], "jack")

        return {
            "type": "state",
            "in_lobby": False,
            "lobby": lobby,
            "game": game_state,
            "me": pid,
            "last_event": self.last_event,
        }


class RoomRegistry:
    """Потокобезопасный реестр всех активных комнат."""

    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._lock = threading.RLock()

    def get_or_create(
        self,
        code: str,
        host_name: str,
        max_players: int = 4,
        translatable: bool = True,
        pair_defense: bool = False,
    ) -> Room:
        with self._lock:
            room = self._rooms.get(code)
            if room is None:
                room = Room(
                    code=code,
                    host_name=host_name,
                    max_players=max_players,
                    translatable=translatable,
                    pair_defense=pair_defense,
                )
                self._rooms[code] = room
            return room

    def get(self, code: str) -> Optional[Room]:
        with self._lock:
            return self._rooms.get(code)

    def drop_if_empty(self, code: str) -> None:
        with self._lock:
            room = self._rooms.get(code)
            if room and room.is_empty:
                del self._rooms[code]

    def stats(self) -> dict:
        with self._lock:
            return {
                "rooms": len(self._rooms),
                "players": sum(len(r.seats) for r in self._rooms.values()),
            }


registry = RoomRegistry()


def parse_card(data: dict) -> Card:
    """Превращает {'rank': '10', 'suit': '♥'} в объект Card с проверкой."""
    if not isinstance(data, dict):
        raise IllegalMove("Неверный формат карты")
    rank = data.get("rank")
    suit = data.get("suit")
    if not rank or not suit:
        raise IllegalMove("В карте не указаны достоинство или масть")
    return Card(rank=str(rank), suit=str(suit))
