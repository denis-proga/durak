"""
Движок игры «Дурак».

Чистая логика без Django и WebSocket — чтобы можно было тестировать в консоли.
Позже поверх него встанет слой Channels, который просто транслирует состояние в комнату.

Реализованные правила (как договорились):
  * 2–6 игроков, колода 36 карт, козырь — нижняя карта колоды
  * ход по часовой стрелке: атакует i, защищается i+1
  * карты кладутся в ЗОНУ-ПРОМЕЖУТОК между атакующим и защищающимся (zone i)
  * подкидывать может любой игрок, у кого есть карта совпадающего достоинства
  * первая атака в партии — максимум 5 карт, дальше — максимум 6
  * переводной режим: перевод картой того же достоинства двигает всю пачку в следующую зону
  * показ козыря: козырь того же достоинства можно ПОКАЗАТЬ, не выкладывая —
    перевод засчитывается, карта остаётся в руке. Один раз на игрока за атаку.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"]
SUITS = ["♠", "♥", "♦", "♣"]
RANK_VALUE = {r: i for i, r in enumerate(RANKS)}

HAND_SIZE = 6
MAX_ATTACK_CARDS = 6
FIRST_BOUT_LIMIT = 5


class Phase(str, Enum):
    WAITING = "waiting"        # ждём игроков
    ATTACK = "attack"          # идёт атака/защита
    ROUND_OVER = "round_over"  # раздача/переход хода
    PAUSED = "paused"          # кто-то отключился, ждём возвращения
    FINISHED = "finished"      # партия окончена


class IllegalMove(Exception):
    """Ход не по правилам. Consumer превратит это в сообщение об ошибке игроку."""


@dataclass(frozen=True)
class Card:
    rank: str
    suit: str

    @property
    def value(self) -> int:
        return RANK_VALUE[self.rank]

    def __str__(self) -> str:
        return f"{self.rank}{self.suit}"

    def to_dict(self) -> dict:
        return {"rank": self.rank, "suit": self.suit}


@dataclass
class Slot:
    """Пара «атака / защита» на столе."""
    attack: Card
    defense: Optional[Card] = None

    @property
    def is_beaten(self) -> bool:
        return self.defense is not None

    def to_dict(self) -> dict:
        return {
            "attack": self.attack.to_dict(),
            "defense": self.defense.to_dict() if self.defense else None,
        }


@dataclass
class Player:
    pid: str
    name: str
    hand: list[Card] = field(default_factory=list)
    is_out: bool = False       # вышел из игры (сбросил все карты)
    connected: bool = True     # на связи ли; при False партия встаёт на паузу
    team: Optional[int] = None # номер команды в парном режиме

    def to_public_dict(self) -> dict:
        """То, что видят ОСТАЛЬНЫЕ: только количество карт, не сами карты."""
        return {
            "pid": self.pid,
            "name": self.name,
            "card_count": len(self.hand),
            "is_out": self.is_out,
            "connected": self.connected,
            "team": self.team,
        }


def build_deck() -> list[Card]:
    return [Card(r, s) for s in SUITS for r in RANKS]


class DurakGame:
    def __init__(
        self,
        players: list[tuple[str, str]],
        translatable: bool = True,
        pair_defense: bool = False,
        seed: Optional[int] = None,
        forced_first_attacker: Optional[str] = None,
    ):
        if not 2 <= len(players) <= 6:
            raise ValueError("Игроков должно быть от 2 до 6")

        self.rng = random.Random(seed)
        self.players: list[Player] = [Player(pid=p, name=n) for p, n in players]
        self.translatable = translatable

        # Парный режим: партнёры сидят ЧЕРЕЗ ОДНОГО.
        # При 4 игроках это даёт пары напротив друг друга (0-2 и 1-3),
        # при 6 — две команды по трое (0-2-4 против 1-3-5).
        # Поэтому требуется чётное число игроков.
        self.pair_defense = pair_defense and len(players) in (4, 6)
        if self.pair_defense:
            for i, p in enumerate(self.players):
                p.team = i % 2

        self.deck: list[Card] = build_deck()
        self.rng.shuffle(self.deck)

        # козырь — нижняя карта колоды, лежит открытой и берётся последней
        self.trump_card: Card = self.deck[0]
        self.trump_suit: str = self.trump_card.suit

        self.table: list[Slot] = []
        self.discard: list[Card] = []

        self.phase: Phase = Phase.ATTACK
        self.first_bout = True
        # сколько карт было у защищающегося на старте захода — ограничивает подкидывание
        self.bout_limit = FIRST_BOUT_LIMIT
        # кто уже воспользовался показом козыря в текущей атаке
        self.trump_shown_by: set[str] = set()
        # кто спасовал в текущем заходе (нажал «бито»/«хватит»)
        self.passed: set[str] = set()
        self.defender_took = False
        self.loser: Optional[Player] = None
        # что и кому досталось в последнем взятии — по этим картам считается погон
        self.last_taken: Optional[tuple[str, list[Card]]] = None

        self._deal_initial()
        self.attacker_index = self._choose_first_attacker(forced_first_attacker)
        self.defender_index = self._next_active(self.attacker_index)
        self._recalc_bout_limit()

    # ---------- Раздача ----------

    def _deal_initial(self) -> None:
        for _ in range(HAND_SIZE):
            for p in self.players:
                p.hand.append(self.deck.pop())

    def _choose_first_attacker(self, forced_pid: Optional[str] = None) -> int:
        """
        Обычно ходит тот, у кого самый младший козырь.
        Но если задан forced_pid (проигравший прошлой партии — по правилам
        первым ходит на дурака он), используем его, если он вообще есть за столом.
        """
        if forced_pid:
            for i, p in enumerate(self.players):
                if p.pid == forced_pid:
                    return i
        best_idx, best_val = None, None
        for i, p in enumerate(self.players):
            for c in p.hand:
                if c.suit == self.trump_suit and (best_val is None or c.value < best_val):
                    best_idx, best_val = i, c.value
        return best_idx if best_idx is not None else 0

    # ---------- Навигация по игрокам ----------

    @property
    def attacker(self) -> Player:
        return self.players[self.attacker_index]

    @property
    def defender(self) -> Player:
        return self.players[self.defender_index]

    def _next_active(self, index: int) -> int:
        n = len(self.players)
        for step in range(1, n + 1):
            cand = (index + step) % n
            if not self.players[cand].is_out:
                return cand
        return index

    def active_players(self) -> list[Player]:
        return [p for p in self.players if not p.is_out]

    def player_by_id(self, pid: str) -> Player:
        for p in self.players:
            if p.pid == pid:
                return p
        raise IllegalMove(f"Игрок {pid} не найден")

    @property
    def gap_index(self) -> int:
        """Номер зоны-промежутка, куда падают карты: между атакующим и защищающимся."""
        return self.attacker_index

    # ---------- Команды (парный режим) ----------

    def teammates_of(self, player: Player) -> list[Player]:
        """Партнёры игрока (без него самого). В обычном режиме — пусто."""
        if not self.pair_defense or player.team is None:
            return []
        return [p for p in self.players if p.team == player.team and p is not player]

    def are_partners(self, a: Player, b: Player) -> bool:
        return self.pair_defense and a.team is not None and a.team == b.team

    def can_throw_in(self, player: Player) -> bool:
        """
        Кто вправе подкидывать.
        Обычный режим — все, кроме защищающегося.
        Парный — только команда атакующего (партнёры кидают вместе).
        """
        if player.is_out or player is self.defender:
            return False
        if self.pair_defense:
            return player.team == self.attacker.team
        return True

    def throwers(self) -> list[Player]:
        return [p for p in self.active_players() if self.can_throw_in(p)]

    # ---------- Подключение игроков ----------

    def set_connected(self, pid: str, connected: bool) -> None:
        """
        Игрок отключился/вернулся. Пока кого-то нет — партия на паузе,
        ходы не принимаются, а клиент подсвечивает стол красным.
        """
        player = self.player_by_id(pid)
        player.connected = connected
        self._sync_pause()

    def _sync_pause(self) -> None:
        if self.phase is Phase.FINISHED:
            return
        missing = self.disconnected_players()
        if missing and self.phase is not Phase.PAUSED:
            self.phase = Phase.PAUSED
        elif not missing and self.phase is Phase.PAUSED:
            self.phase = Phase.ATTACK

    def disconnected_players(self) -> list[Player]:
        return [p for p in self.players if not p.connected and not p.is_out]

    def _require_running(self) -> None:
        if self.phase is Phase.PAUSED:
            names = ", ".join(p.name for p in self.disconnected_players())
            raise IllegalMove(f"Партия на паузе — нет связи с: {names}")
        if self.phase is Phase.FINISHED:
            raise IllegalMove("Партия уже окончена")

    # ---------- Правила ----------

    def beats(self, attack: Card, defense: Card) -> bool:
        """Бьёт ли defense карту attack."""
        if defense.suit == attack.suit:
            return defense.value > attack.value
        return defense.suit == self.trump_suit and attack.suit != self.trump_suit

    def table_ranks(self) -> set[str]:
        ranks = set()
        for slot in self.table:
            ranks.add(slot.attack.rank)
            if slot.defense:
                ranks.add(slot.defense.rank)
        return ranks

    def _recalc_bout_limit(self) -> None:
        cap = FIRST_BOUT_LIMIT if self.first_bout else MAX_ATTACK_CARDS
        self.bout_limit = min(cap, len(self.defender.hand))

    def undefended(self) -> list[Slot]:
        return [s for s in self.table if not s.is_beaten]

    # ---------- Действия ----------

    def attack_with(self, pid: str, card: Card) -> None:
        """Атака или подкидывание."""
        self._require_running()
        if self.phase is not Phase.ATTACK:
            raise IllegalMove("Сейчас нельзя ходить")

        player = self.player_by_id(pid)
        if card not in player.hand:
            raise IllegalMove("Этой карты нет в руке")
        if len(self.table) >= self.bout_limit:
            raise IllegalMove(f"Достигнут лимит: на столе уже {self.bout_limit} карт")

        if not self.table:
            # первая карта захода — только атакующий
            if player is not self.attacker:
                raise IllegalMove("Первым ходит атакующий")
        else:
            if not self.can_throw_in(player):
                if player is self.defender:
                    raise IllegalMove("Защищающийся не может подкидывать")
                raise IllegalMove("В парном режиме подкидывает только команда атакующего")
            # ГЛАВНАЯ ПРОВЕРКА: подкинуть можно только совпадающее достоинство.
            # Если на столе 6 и Дама, король просто не ляжет.
            if card.rank not in self.table_ranks():
                allowed = ", ".join(sorted(self.table_ranks(), key=lambda r: RANK_VALUE[r]))
                raise IllegalMove(f"Подкинуть можно только: {allowed}")

        player.hand.remove(card)
        self.table.append(Slot(attack=card))
        # новая карта на столе — «движки готовности» сбрасываются,
        # то есть передумавший игрок снова может подкинуть
        self.passed.clear()

    def defend_with(self, pid: str, slot_index: int, card: Card) -> None:
        self._require_running()
        if self.phase is not Phase.ATTACK:
            raise IllegalMove("Сейчас нельзя отбиваться")
        player = self.player_by_id(pid)
        if player is not self.defender:
            raise IllegalMove("Отбиваться может только защищающийся")
        if self.defender_took:
            raise IllegalMove("Ты уже взял карты")
        if not 0 <= slot_index < len(self.table):
            raise IllegalMove("Нет такой карты на столе")

        slot = self.table[slot_index]
        if slot.is_beaten:
            raise IllegalMove("Эта карта уже отбита")
        if card not in player.hand:
            raise IllegalMove("Этой карты нет в руке")
        if not self.beats(slot.attack, card):
            raise IllegalMove(f"{card} не бьёт {slot.attack}")

        player.hand.remove(card)
        slot.defense = card

    def translate(self, pid: str, card: Card) -> None:
        """
        Перевод картой: кладём карту того же достоинства, что и карты в атаке.
        Вся пачка уезжает в следующую зону, защищающимся становится следующий игрок.
        """
        self._check_can_translate(pid, card)
        player = self.player_by_id(pid)

        player.hand.remove(card)
        self.table.append(Slot(attack=card))
        self._shift_attack_forward()

    def show_trump_translate(self, pid: str, card: Card) -> dict:
        """
        Перевод показом козыря: карта ОСТАЁТСЯ в руке, но перевод засчитывается.
        Козырь должен быть того же достоинства, что и карты в атаке.
        Один раз на игрока за атаку.
        """
        self._require_running()
        if not self.translatable:
            raise IllegalMove("В этом режиме перевод запрещён")
        if pid in self.trump_shown_by:
            raise IllegalMove("Показать козырь можно только один раз за атаку — теперь клади его на стол")

        player = self.player_by_id(pid)
        if player is not self.defender:
            raise IllegalMove("Переводить может только защищающийся")
        if card not in player.hand:
            raise IllegalMove("Этой карты нет в руке")
        if card.suit != self.trump_suit:
            raise IllegalMove("Показать можно только козырь")
        if not self.table:
            raise IllegalMove("Нечего переводить")
        attack_rank = self.table[0].attack.rank
        if card.rank != attack_rank:
            raise IllegalMove(f"Козырь должен быть того же достоинства ({attack_rank})")
        if any(s.is_beaten for s in self.table):
            raise IllegalMove("Переводить можно, только пока ничего не отбито")

        self.trump_shown_by.add(pid)
        self._shift_attack_forward()
        # возвращаем показанную карту — её увидят все игроки
        return {"shown_by": pid, "card": card.to_dict()}

    def _check_can_translate(self, pid: str, card: Card) -> None:
        self._require_running()
        if not self.translatable:
            raise IllegalMove("В этом режиме перевод запрещён")
        if self.phase is not Phase.ATTACK:
            raise IllegalMove("Сейчас нельзя переводить")
        player = self.player_by_id(pid)
        if player is not self.defender:
            raise IllegalMove("Переводить может только защищающийся")
        if card not in player.hand:
            raise IllegalMove("Этой карты нет в руке")
        if not self.table:
            raise IllegalMove("Нечего переводить")
        if any(s.is_beaten for s in self.table):
            raise IllegalMove("Переводить можно, только пока ничего не отбито")
        if card.rank != self.table[0].attack.rank:
            raise IllegalMove("Перевести можно только картой того же достоинства")

        next_defender = self.players[self._next_active(self.defender_index)]
        if len(self.table) + 1 > len(next_defender.hand):
            raise IllegalMove("У следующего игрока не хватает карт, чтобы принять перевод")

    def _shift_attack_forward(self) -> None:
        """Перевод: атакующим становится бывший защищающийся, пачка едет в следующую зону."""
        self.attacker_index = self.defender_index
        self.defender_index = self._next_active(self.defender_index)
        self.passed.clear()
        self._recalc_bout_limit()

    def take(self, pid: str) -> None:
        """Защищающийся забирает все карты со стола."""
        self._require_running()
        player = self.player_by_id(pid)
        if player is not self.defender:
            raise IllegalMove("Взять карты может только защищающийся")
        if not self.table:
            raise IllegalMove("На столе нет карт")
        self.defender_took = True

    def pass_turn(self, pid: str) -> None:
        """
        «Движок готовности»: игрок говорит «я всё выкинул, играйте дальше».
        Пока движок включён, он ждёт остальных. Если кто-то подкинет карту,
        движок сбрасывается — можно передумать и подкинуть ещё, либо включить снова.
        Работает и в парном режиме: партнёры включают готовность каждый за себя,
        иначе не было бы способа закрыть заход после взятия карт.
        """
        self._require_running()
        player = self.player_by_id(pid)
        if player is self.defender:
            raise IllegalMove("Защищающийся не пасует — он либо отбивается, либо берёт")
        if not self.can_throw_in(player):
            raise IllegalMove("Сейчас не твоя очередь подкидывать")
        if not self.table:
            raise IllegalMove("Заход ещё не начался")
        self.passed.add(pid)

    def unpass(self, pid: str) -> None:
        """Передумал: выключает свой движок готовности, снова хочет подкинуть."""
        self._require_running()
        self.passed.discard(pid)

    def legal_throw_ins(self, pid: str) -> list[Card]:
        """
        Какие карты игрок реально может выложить прямо сейчас.
        Фронт использует это, чтобы гасить недопустимые карты в руке,
        а не давать выкинуть короля на шестёрку с дамой.
        """
        player = self.player_by_id(pid)
        if self.phase is not Phase.ATTACK:
            return []
        if len(self.table) >= self.bout_limit:
            return []
        if not self.table:
            return list(player.hand) if player is self.attacker else []
        if not self.can_throw_in(player):
            return []
        ranks = self.table_ranks()
        return [c for c in player.hand if c.rank in ranks]

    def everyone_passed(self) -> bool:
        """
        Заход можно закрывать, когда все, кто мог подкинуть, включили движок
        готовности — это правило одинаковое и в обычном, и в парном режиме.
        """
        return all(p.pid in self.passed for p in self.throwers())

    def all_beaten(self) -> bool:
        return bool(self.table) and all(s.is_beaten for s in self.table)

    # ---------- Завершение захода ----------

    def resolve_bout(self) -> None:
        """
        Закрывает заход: карты уходят в отбой или защищающемуся, все добирают из колоды,
        ход переходит дальше.
        """
        self._require_running()
        if not self.table:
            raise IllegalMove("Нечего закрывать")

        if self.defender_took:
            taken: list[Card] = []
            for slot in self.table:
                self.defender.hand.append(slot.attack)
                taken.append(slot.attack)
                if slot.defense:
                    self.defender.hand.append(slot.defense)
                    taken.append(slot.defense)
            self.last_taken = (self.defender.pid, taken)
            # взявший пропускает ход: атакует следующий за ним
            next_attacker = self._next_active(self.defender_index)
        else:
            for slot in self.table:
                self.discard.append(slot.attack)
                if slot.defense:
                    self.discard.append(slot.defense)
            # отбился — сам становится атакующим
            next_attacker = self.defender_index

        self.table.clear()
        self.passed.clear()
        self.trump_shown_by.clear()
        self.defender_took = False
        self.first_bout = False

        self._refill_hands()
        self._update_out_players()

        if self._check_game_over():
            return

        # если назначенный атакующий вышел из игры — берём следующего активного
        if self.players[next_attacker].is_out:
            next_attacker = self._next_active(next_attacker)
        self.attacker_index = next_attacker
        self.defender_index = self._next_active(self.attacker_index)
        self._recalc_bout_limit()

    def _refill_hands(self) -> None:
        """Добор до 6 карт: сначала атакующий, потом по кругу, защищающийся — последним."""
        order: list[Player] = []
        n = len(self.players)
        for step in range(n):
            p = self.players[(self.attacker_index + step) % n]
            if p is not self.defender and not p.is_out:
                order.append(p)
        if not self.defender.is_out:
            order.append(self.defender)

        for p in order:
            while len(p.hand) < HAND_SIZE and self.deck:
                p.hand.append(self.deck.pop())

    def _update_out_players(self) -> None:
        if self.deck:
            return  # пока колода не пуста, выйти нельзя
        for p in self.players:
            if not p.hand:
                p.is_out = True

    def outcome_is_settled(self) -> Optional[Player]:
        """
        Иногда исход очевиден ещё до конца захода: колода пуста, все кроме одного
        сбросили карты, а у последнего на руках больше одной карты — даже если он
        отобьётся, карты останутся, и он всё равно дурак. Ждать нет смысла.

        Исключение — ровно одна карта против одной: там возможна ничья,
        поэтому доигрываем честно.
        """
        if self.deck:
            return None
        with_cards = [p for p in self.players if p.hand and not p.is_out]
        if len(with_cards) != 1:
            return None

        last = with_cards[0]
        # сколько карт ему ещё предстоит принять/отбить на столе
        pending = len(self.undefended())
        if len(last.hand) - pending > 1 or (pending == 0 and len(last.hand) > 1):
            return last
        return None

    def force_finish(self) -> Optional[Player]:
        """Досрочно завершает партию, когда исход уже предрешён."""
        loser = self.outcome_is_settled()
        if loser is None:
            return None
        for p in self.players:
            if p is not loser:
                p.is_out = True
        if self.table:
            taken = []
            for slot in self.table:
                taken.append(slot.attack)
                if slot.defense:
                    taken.append(slot.defense)
            loser.hand.extend(taken)
            self.last_taken = (loser.pid, taken)
        self.table.clear()
        self.phase = Phase.FINISHED
        self.loser = loser
        return loser

    def _check_game_over(self) -> bool:
        remaining = self.active_players()
        if len(remaining) <= 1:
            self.phase = Phase.FINISHED
            self.loser = remaining[0] if remaining else None
            return True
        return False

    # ---------- Состояние для клиента ----------

    def state_for(self, pid: Optional[str] = None) -> dict:
        """
        Состояние игры. Рука видна только своему владельцу — остальным
        отдаём лишь количество карт, чтобы нельзя было подсмотреть через devtools.
        """
        me = None
        if pid is not None:
            me = next((p for p in self.players if p.pid == pid), None)

        disconnected = self.disconnected_players()

        return {
            "phase": self.phase.value,
            "paused": self.phase is Phase.PAUSED,
            "disconnected": [
                {"pid": p.pid, "name": p.name} for p in disconnected
            ],
            "trump_suit": self.trump_suit,
            "trump_card": self.trump_card.to_dict(),
            "deck_count": len(self.deck),
            "discard_count": len(self.discard),
            "table": [s.to_dict() for s in self.table],
            "gap_index": self.gap_index,
            "attacker": self.attacker.pid,
            "defender": self.defender.pid,
            "bout_limit": self.bout_limit,
            "defender_took": self.defender_took,
            "passed": sorted(self.passed),
            "trump_shown_by": sorted(self.trump_shown_by),
            "rules": {
                "translatable": self.translatable,
                "pair_defense": self.pair_defense,
                "has_ready_toggle": True,
            },
            "players": [p.to_public_dict() for p in self.players],
            "my_hand": [c.to_dict() for c in me.hand] if me else [],
            # какие карты из руки реально можно выложить — фронт гасит остальные
            "my_legal_cards": (
                [c.to_dict() for c in self.legal_throw_ins(me.pid)] if me else []
            ),
            "my_team": me.team if me else None,
            "my_partners": (
                [p.pid for p in self.teammates_of(me)] if me else []
            ),
            "can_throw_in": bool(me and self.can_throw_in(me)),
            "loser": self.loser.pid if self.loser else None,
        }
