"""Проверка ключевых правил движка."""

from durak_engine import Card, DurakGame, IllegalMove, Phase

OK = "✓"
FAIL = "✗"
results = []


def check(name, condition):
    results.append((name, bool(condition)))
    print(f"{OK if condition else FAIL} {name}")


def expect_illegal(name, fn):
    try:
        fn()
        results.append((name, False))
        print(f"{FAIL} {name} — ход прошёл, хотя должен был быть отклонён")
    except IllegalMove:
        results.append((name, True))
        print(f"{OK} {name}")


players4 = [("p1", "Денис"), ("p2", "Максим"), ("p3", "Оля"), ("p4", "Дима")]

print("\n=== Раздача и старт ===")
g = DurakGame(players4, seed=42)
check("каждому роздано по 6 карт", all(len(p.hand) == 6 for p in g.players))
check("в колоде осталось 36-24=12 карт", len(g.deck) == 12)
check("козырь = масть нижней карты", g.trump_card.suit == g.trump_suit)
check("атакующий и защищающийся разные", g.attacker_index != g.defender_index)
check("зона = индекс атакующего", g.gap_index == g.attacker_index)

print("\n=== Старшинство карт ===")
g2 = DurakGame(players4, seed=1)
g2.trump_suit = "♠"
check("старшая той же масти бьёт младшую", g2.beats(Card("7", "♥"), Card("10", "♥")))
check("младшая не бьёт старшую", not g2.beats(Card("10", "♥"), Card("7", "♥")))
check("козырь бьёт некозырь", g2.beats(Card("A", "♥"), Card("6", "♠")))
check("некозырь не бьёт козырь", not g2.beats(Card("6", "♠"), Card("A", "♥")))
check("чужая масть не бьёт", not g2.beats(Card("7", "♥"), Card("K", "♦")))
check("старший козырь бьёт младший козырь", g2.beats(Card("7", "♠"), Card("K", "♠")))

print("\n=== Атака и подкидывание ===")
g3 = DurakGame(players4, seed=7)
atk, dfn = g3.attacker, g3.defender
first = atk.hand[0]
g3.attack_with(atk.pid, first)
check("карта легла на стол", len(g3.table) == 1)
check("карта ушла из руки", first not in atk.hand)

expect_illegal(
    "защищающийся не может подкидывать",
    lambda: g3.attack_with(dfn.pid, dfn.hand[0]),
)

other = next(p for p in g3.players if p not in (atk, dfn))
mismatched = next((c for c in other.hand if c.rank not in g3.table_ranks()), None)
if mismatched:
    expect_illegal(
        "нельзя подкинуть карту другого достоинства",
        lambda: g3.attack_with(other.pid, mismatched),
    )

print("\n=== Защита ===")
g4 = DurakGame(players4, seed=11)
atk, dfn = g4.attacker, g4.defender
# подбираем гарантированно отбиваемую пару
attack_card = None
defense_card = None
for a in atk.hand:
    for d in dfn.hand:
        if g4.beats(a, d):
            attack_card, defense_card = a, d
            break
    if attack_card:
        break

if attack_card:
    g4.attack_with(atk.pid, attack_card)
    g4.defend_with(dfn.pid, 0, defense_card)
    check("слот отбит", g4.table[0].is_beaten)
    check("все карты отбиты", g4.all_beaten())
    expect_illegal(
        "нельзя отбить уже отбитый слот",
        lambda: g4.defend_with(dfn.pid, 0, dfn.hand[0]),
    )

print("\n=== Перевод картой ===")
# конструируем ситуацию вручную: у защищающегося есть карта того же достоинства
g5 = DurakGame(players4, seed=3)
atk, dfn = g5.attacker, g5.defender
nxt = g5.players[g5._next_active(g5.defender_index)]
atk.hand = [Card("7", "♠"), Card("K", "♦")]
dfn.hand = [Card("7", "♥"), Card("9", "♣")]
nxt.hand = [Card("A", "♦"), Card("Q", "♣"), Card("6", "♥")]
old_attacker = g5.attacker_index
g5.attack_with(atk.pid, Card("7", "♠"))
g5.translate(dfn.pid, Card("7", "♥"))
check("после перевода на столе две карты", len(g5.table) == 2)
check("бывший защищающийся стал атакующим", g5.attacker_index != old_attacker)
check("зона сдвинулась вперёд", g5.gap_index == g5.attacker_index)

print("\n=== Показ козыря ===")
g6 = DurakGame(players4, seed=5)
g6.trump_suit = "♦"
atk, dfn = g6.attacker, g6.defender
nxt = g6.players[g6._next_active(g6.defender_index)]
atk.hand = [Card("8", "♠")]
dfn.hand = [Card("8", "♦"), Card("K", "♣")]  # козырная восьмёрка
nxt.hand = [Card("A", "♣"), Card("Q", "♠"), Card("6", "♥")]
g6.attack_with(atk.pid, Card("8", "♠"))
shown = g6.show_trump_translate(dfn.pid, Card("8", "♦"))
check("показанный козырь остался в руке", Card("8", "♦") in dfn.hand)
check("на столе по-прежнему одна карта", len(g6.table) == 1)
check("показ вернул карту для показа всем", shown["card"]["rank"] == "8")
check("перевод засчитан — сменился атакующий", g6.attacker is dfn)

expect_illegal(
    "повторный показ козыря в той же атаке запрещён",
    lambda: g6.show_trump_translate(dfn.pid, Card("8", "♦")),
)

g7 = DurakGame(players4, seed=9)
g7.trump_suit = "♦"
atk, dfn = g7.attacker, g7.defender
atk.hand = [Card("8", "♠")]
dfn.hand = [Card("9", "♦")]
g7.attack_with(atk.pid, Card("8", "♠"))
expect_illegal(
    "козырь другого достоинства показать нельзя",
    lambda: g7.show_trump_translate(dfn.pid, Card("9", "♦")),
)

print("\n=== Взятие карт ===")
g8 = DurakGame(players4, seed=13)
atk, dfn = g8.attacker, g8.defender
card = atk.hand[0]
before = len(dfn.hand)
g8.attack_with(atk.pid, card)
g8.take(dfn.pid)
g8.resolve_bout()
check("защищающийся забрал карту", len(dfn.hand) >= before)
check("стол очищен", len(g8.table) == 0)
check("после взятия атакует следующий, а не взявший", g8.attacker is not dfn)

print("\n=== Отбой и добор ===")
g9 = DurakGame(players4, seed=17)
atk, dfn = g9.attacker, g9.defender
pair = None
for a in atk.hand:
    for d in dfn.hand:
        if g9.beats(a, d):
            pair = (a, d)
            break
    if pair:
        break
if pair:
    g9.attack_with(atk.pid, pair[0])
    g9.defend_with(dfn.pid, 0, pair[1])
    g9.resolve_bout()
    check("карты ушли в отбой", len(g9.discard) == 2)
    check("руки добраны до 6", all(len(p.hand) == 6 for p in g9.players))
    check("отбившийся стал атакующим", g9.attacker is dfn)

print("\n=== Лимит подкидывания ===")
g10 = DurakGame(players4, seed=23)
check("первый заход ограничен 5 картами", g10.bout_limit <= 5)

print("\n=== Игра на двоих доходит до конца ===")
g11 = DurakGame([("a", "A"), ("b", "B")], seed=99)
guard = 0
while g11.phase is not Phase.FINISHED and guard < 4000:
    guard += 1
    d = g11.defender
    a = g11.attacker
    if not g11.table:
        legal = [c for c in a.hand]
        if not legal:
            break
        g11.attack_with(a.pid, legal[0])
        continue
    slot = next((s for s in g11.table if not s.is_beaten), None)
    if slot:
        beat = next((c for c in d.hand if g11.beats(slot.attack, c)), None)
        if beat:
            g11.defend_with(d.pid, g11.table.index(slot), beat)
        else:
            g11.take(d.pid)
            g11.resolve_bout()
        continue
    extra = next(
        (c for c in a.hand if c.rank in g11.table_ranks() and len(g11.table) < g11.bout_limit),
        None,
    )
    if extra:
        g11.attack_with(a.pid, extra)
    else:
        g11.resolve_bout()

check("партия завершилась", g11.phase is Phase.FINISHED)
check("определён проигравший или ничья", g11.loser is not None or len(g11.active_players()) == 0)
check("колода израсходована", len(g11.deck) == 0)

print("\n=== Приватность состояния ===")
g12 = DurakGame(players4, seed=31)
st = g12.state_for("p1")
check("своя рука видна", len(st["my_hand"]) == 6)
check("чужие руки скрыты", all("hand" not in p for p in st["players"]))
check("видно только количество чужих карт", all(p["card_count"] == 6 for p in st["players"]))

passed = sum(1 for _, ok in results if ok)
total = len(results)
print(f"\n{'=' * 40}")
print(f"Пройдено: {passed}/{total}")
if passed < total:
    print("Провалились:")
    for name, ok in results:
        if not ok:
            print(f"  - {name}")


# ============ НОВЫЕ ПРАВИЛА ============
from durak_engine import Card as C2

print("\n=== Контроль достоинства при подкидывании ===")
gv = DurakGame(players4, seed=77)
atk, dfn = gv.attacker, gv.defender
other = next(p for p in gv.players if p not in (atk, dfn))
atk.hand = [C2("6", "♠"), C2("J", "♥")]
dfn.hand = [C2("Q", "♠"), C2("A", "♥"), C2("A", "♦"), C2("A", "♣"), C2("10", "♠"), C2("10", "♥")]
other.hand = [C2("K", "♣"), C2("6", "♦"), C2("Q", "♦")]
gv._recalc_bout_limit()
gv.attack_with(atk.pid, C2("6", "♠"))
gv.defend_with(dfn.pid, 0, C2("Q", "♠"))  # отбилась Дамой — теперь на столе 6 и Дама
check("на столе 6 и Дама", gv.table_ranks() == {"6", "Q"})
expect_illegal(
    "короля на 6 и Даму подкинуть нельзя",
    lambda: gv.attack_with(other.pid, C2("K", "♣")),
)
gv.attack_with(other.pid, C2("6", "♦"))
check("шестёрку подкинуть можно", len(gv.table) == 2)
legal = gv.legal_throw_ins(other.pid)
check("король не попал в список разрешённых", C2("K", "♣") not in legal)
check("дама попала в список разрешённых", C2("Q", "♦") in legal)

print("\n=== Движок готовности ===")
gt = DurakGame(players4, seed=81)
atk, dfn = gt.attacker, gt.defender
others = [p for p in gt.players if p not in (atk, dfn)]
gt.attack_with(atk.pid, atk.hand[0])
gt.pass_turn(atk.pid)
check("движок включён", atk.pid in gt.passed)
for o in others:
    gt.pass_turn(o.pid)
check("все включили движок — заход можно закрывать", gt.everyone_passed())
# кто-то подкидывает — движки сбрасываются
thrower = next((o for o in others if any(c.rank in gt.table_ranks() for c in o.hand)), None)
if thrower:
    card = next(c for c in thrower.hand if c.rank in gt.table_ranks())
    gt.attack_with(thrower.pid, card)
    check("после подкидывания движки сброшены", len(gt.passed) == 0)
    check("заход больше не считается законченным", not gt.everyone_passed())
gt.pass_turn(atk.pid)
gt.unpass(atk.pid)
check("передумал — движок выключен", atk.pid not in gt.passed)

print("\n=== Парный режим: состав команд ===")
gp4 = DurakGame(players4, pair_defense=True, seed=5)
check("4 игрока: парный режим включился", gp4.pair_defense)
check("команды через одного (0,2) и (1,3)",
      gp4.players[0].team == gp4.players[2].team and gp4.players[1].team == gp4.players[3].team)
check("соседи в разных командах", gp4.players[0].team != gp4.players[1].team)
check("партнёр находится напротив", gp4.teammates_of(gp4.players[0])[0] is gp4.players[2])

players6 = [(f"q{i}", f"И{i}") for i in range(6)]
gp6 = DurakGame(players6, pair_defense=True, seed=5)
check("6 игроков: парный режим включился", gp6.pair_defense)
check("команда A = места 0,2,4",
      {p.pid for p in gp6.players if p.team == 0} == {"q0", "q2", "q4"})
check("команда B = места 1,3,5",
      {p.pid for p in gp6.players if p.team == 1} == {"q1", "q3", "q5"})

players5 = [(f"r{i}", f"И{i}") for i in range(5)]
gp5 = DurakGame(players5, pair_defense=True, seed=5)
check("5 игроков: парный режим невозможен, откатился в обычный", not gp5.pair_defense)

print("\n=== Парный режим: кто подкидывает ===")
gpp = DurakGame(players4, pair_defense=True, seed=44)
atk, dfn = gpp.attacker, gpp.defender
partner = gpp.teammates_of(atk)[0]
enemy = next(p for p in gpp.players if p not in (atk, dfn, partner))
atk.hand = [C2("9", "♠"), C2("J", "♦")]
partner.hand = [C2("9", "♥"), C2("K", "♣")]
enemy.hand = [C2("9", "♣"), C2("2" if False else "Q", "♦")]
dfn.hand = [C2("A", "♠"), C2("A", "♥"), C2("A", "♦"), C2("A", "♣"), C2("10", "♠"), C2("10", "♥")]
gpp._recalc_bout_limit()
gpp.attack_with(atk.pid, C2("9", "♠"))
check("партнёр атакующего вправе подкидывать", gpp.can_throw_in(partner))
check("соперник подкидывать не вправе", not gpp.can_throw_in(enemy))
gpp.attack_with(partner.pid, C2("9", "♥"))
check("партнёр подкинул — на столе 2 карты", len(gpp.table) == 2)
expect_illegal(
    "соперник не может подкинуть в парном режиме",
    lambda: gpp.attack_with(enemy.pid, C2("9", "♣")),
)
# Раньше движка готовности не было вовсе — из-за этого в реальной игре
# нельзя было закрыть заход после взятия карт. Теперь он работает
# так же, как в обычном режиме: каждый готовится сам за себя.
gpp.pass_turn(atk.pid)
check("атакующий в парном режиме может включить готовность", atk.pid in gpp.passed)
gpp.pass_turn(partner.pid)
check("готовность партнёра тоже засчитывается", partner.pid in gpp.passed)
check("когда оба готовы — заход можно закрывать", gpp.everyone_passed())
expect_illegal(
    "соперник вне команды атакующего готовность не подтверждает",
    lambda: gpp.pass_turn(enemy.pid),
)

print("\n=== Лимит 6 карт в парном режиме ===")
gl = DurakGame(players4, pair_defense=True, seed=55)
gl.first_bout = False
atk, dfn = gl.attacker, gl.defender
partner = gl.teammates_of(atk)[0]
atk.hand = [C2(r, "♠") for r in ["7", "7", "7"]][:1] + [C2("7", "♠"), C2("7", "♥"), C2("7", "♦")]
atk.hand = [C2("7", "♠"), C2("7", "♥"), C2("7", "♦")]
partner.hand = [C2("7", "♣"), C2("8", "♠"), C2("8", "♥")]
dfn.hand = [C2("A", s) for s in ["♠", "♥", "♦", "♣"]] + [C2("K", "♠"), C2("K", "♥")]
gl._recalc_bout_limit()
check("лимит захода = 6", gl.bout_limit == 6)
gl.attack_with(atk.pid, C2("7", "♠"))
gl.attack_with(partner.pid, C2("7", "♣"))
gl.attack_with(atk.pid, C2("7", "♥"))
gl.attack_with(atk.pid, C2("7", "♦"))
check("команда набросала 4 карты вместе", len(gl.table) == 4)

print("\n=== Отключение игрока ===")
gd = DurakGame(players4, seed=61)
atk = gd.attacker
gd.set_connected("p3", False)
check("партия встала на паузу", gd.phase is Phase.PAUSED)
check("отключившийся в списке", [p.pid for p in gd.disconnected_players()] == ["p3"])
st = gd.state_for("p1")
check("состояние сообщает о паузе", st["paused"] is True)
check("состояние называет отключившегося", st["disconnected"][0]["name"] == "Оля")
expect_illegal("на паузе ходить нельзя", lambda: gd.attack_with(atk.pid, atk.hand[0]))
gd.set_connected("p3", False)
gd.set_connected("p3", True)
check("после возвращения партия продолжается", gd.phase is Phase.ATTACK)
gd.attack_with(gd.attacker.pid, gd.attacker.hand[0])
check("ход снова принимается", len(gd.table) == 1)

passed2 = sum(1 for _, ok in results if ok)
total2 = len(results)
print(f"\n{'=' * 40}")
print(f"ИТОГО пройдено: {passed2}/{total2}")
if passed2 < total2:
    print("Провалились:")
    for name, ok in results:
        if not ok:
            print(f"  - {name}")

print("\n=== Проигравший ЗАЩИЩАЕТСЯ первым в следующей партии ===")
# Важно: раньше по ошибке проигравший становился АТАКУЮЩИМ — это неверно,
# по правилам «ходят на дурака», то есть он отбивается первым.
g_forced = DurakGame(players4, seed=1, forced_first_defender="p2")
check("проигравший назначен защищающимся", g_forced.defender.pid == "p2")
check("проигравший НЕ атакующий", g_forced.attacker.pid != "p2")
# атакующий — тот, кто сидит перед ним по кругу (следующий активный назад)
expected_attacker_idx = g_forced._prev_active(
    next(i for i, p in enumerate(g_forced.players) if p.pid == "p2")
)
check("атакует игрок, сидящий перед проигравшим",
      g_forced.attacker_index == expected_attacker_idx)

# если форсированного игрока больше нет за столом — обычная логика (младший козырь)
g_fallback = DurakGame(players4, seed=1, forced_first_defender="not-at-table")
check("если проигравшего больше нет — обычный выбор атакующего",
      g_fallback.attacker.pid != "not-at-table" and g_fallback.defender.pid != "not-at-table")

print("\n=== Погон не цепляется, если часть карт этого захода уже отбита ===")
# Ровно сценарий пользователя: две карты отбиты (одна — козырной шестёркой),
# затем подкинута третья карта — обычная шестёрка, которую не отбили.
# По правилу взятия защищающийся забирает ВЕСЬ стол, включая уже отбитые пары —
# значит козырная шестёрка возвращается ему в руку. Но погон это не должно
# засчитывать: заход был "смешанным" (уже был успешный отбой до взятия).
#
# Реалистичная последовательность (подкидывать можно только совпадающим
# достоинством — ЛИБО атаки, ЛИБО уже сыгранной защиты):
#   карта 1: атакующий кидает 7♠ — защищающийся бьёт 8♠ (та же масть, старше)
#   карта 2: атакующий кидает 8♥ (ранг 8 уже на столе) — защищающийся бьёт
#            козырной 6♦ (козырь бьёт любую некозырную карту, даже младше)
#   карта 3: атакующий кидает 6♣ (ранг 6 теперь на столе — это же и есть
#            козырь, которым только что отбились) — защищающийся отбить не может
gc = DurakGame(players4, seed=61)
gc.trump_suit = "♦"
atk, dfn = gc.attacker, gc.defender

atk.hand = [C2("7", "♠"), C2("8", "♥"), C2("6", "♣")]
dfn.hand = [C2("8", "♠"), C2("6", "♦"), C2("9", "♥")]
gc._recalc_bout_limit()

gc.attack_with(atk.pid, C2("7", "♠"))
gc.defend_with(dfn.pid, 0, C2("8", "♠"))
check("первая карта отбита", gc.table[0].is_beaten)

gc.attack_with(atk.pid, C2("8", "♥"))
gc.defend_with(dfn.pid, 1, C2("6", "♦"))  # козырная шестёрка бьёт восьмёрку
check("вторая карта отбита козырем", gc.table[1].is_beaten)

gc.attack_with(atk.pid, C2("6", "♣"))
check("на столе три карты, третья не отбита", len(gc.table) == 3 and not gc.table[2].is_beaten)

gc.take(dfn.pid)
gc.resolve_bout()

check("взятие отмечено как НЕ чистое", gc.last_taken_clean is False)
check("защищающийся забрал весь стол, включая свой козырь",
      C2("6", "♦") in dfn.hand and C2("6", "♣") in dfn.hand)

room_pid_map = {p.pid: p.name for p in gc.players}
matching_taken = gc.last_taken[1] if gc.last_taken else []
check("среди взятых карт есть обе шестёрки (это и вводило в заблуждение)",
      sum(1 for c in matching_taken if c.rank == "6") == 2)

# Эмулируем то, что делает Room.record_result — тот же вызов evaluate_epaulette,
# но теперь он должен быть заблокирован флагом last_taken_clean
import os, sys
sys.path.insert(0, '/home/claude/backend')
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "durak_server.settings")
import django
django.setup()
from game.rooms import evaluate_epaulette

# Старое (неверное) поведение для сравнения: без проверки last_taken_clean
naive_outcome = evaluate_epaulette(0, matching_taken, "♦")
check("без фикса это ошибочно засчиталось бы погоном", naive_outcome is not None)
check("но game.last_taken_clean корректно помечает заход как нечистый",
      gc.last_taken_clean is False)

print("\n=== Чистое взятие по-прежнему засчитывается нормально ===")
gc2 = DurakGame(players4, seed=71)
gc2.trump_suit = "♣"
atk2, dfn2 = gc2.attacker, gc2.defender
atk2.hand = [C2("6", "♠")]
dfn2.hand = [C2("A", "♦")]
gc2._recalc_bout_limit()
gc2.attack_with(atk2.pid, C2("6", "♠"))
gc2.take(dfn2.pid)
gc2.resolve_bout()
check("взятие с нуля (ничего не отбивал) отмечено как чистое", gc2.last_taken_clean is True)
outcome2 = evaluate_epaulette(0, gc2.last_taken[1], "♣")
check("и погон в этом случае честно засчитывается", outcome2 is not None and outcome2["new_level"] == 1)
