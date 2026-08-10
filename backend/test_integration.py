"""
Интеграционный тест: две настоящие WebSocket-сессии играют партию.
Проверяет весь стек — consumer, реестр комнат, движок, приватность рук.
"""

import asyncio
import json
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "durak_server.settings")
django.setup()

from channels.testing import WebsocketCommunicator  # noqa: E402

from durak_server.asgi import application  # noqa: E402

results = []


def check(name, ok):
    results.append((name, bool(ok)))
    print(f"{'✓' if ok else '✗'} {name}")


async def connect(code, name, char="jack", **params):
    qs = f"name={name}&char={char}"
    for k, v in params.items():
        qs += f"&{k}={v}"
    comm = WebsocketCommunicator(application, f"/ws/room/{code}/?{qs}")
    connected, _ = await comm.connect()
    return comm, connected


async def recv(comm, timeout=3):
    raw = await asyncio.wait_for(comm.receive_from(), timeout=timeout)
    return json.loads(raw)


async def drain(comm, n=6):
    """Считывает накопившиеся пакеты, возвращает последний state."""
    last = None
    for _ in range(n):
        try:
            msg = await asyncio.wait_for(comm.receive_from(), timeout=0.35)
            data = json.loads(msg)
            if data.get("type") == "state":
                last = data
            elif data.get("type") == "error":
                print(f"    ! ошибка сервера: {data['message']}")
        except asyncio.TimeoutError:
            break
    return last


async def send(comm, payload):
    await comm.send_to(text_data=json.dumps(payload))


async def main():
    print("=== Подключение и лобби ===")
    a, ok_a = await connect("TEST01", "Денис")
    check("первый игрок подключился", ok_a)
    st = await recv(a)
    check("пришло состояние лобби", st["in_lobby"] is True)
    check("создатель комнаты — первый вошедший", st["lobby"]["host"] == "Денис")

    b, ok_b = await connect("TEST01", "Максим", char="mei")
    check("второй игрок подключился", ok_b)
    await drain(a)
    st_b = await drain(b)
    check("в лобби двое", len(st_b["lobby"]["seats"]) == 2)
    check("можно начинать", st_b["lobby"]["can_start"] is True)

    print("\n=== Запрет старта не-хостом ===")
    await send(b, {"action": "start"})
    err = None
    for _ in range(4):
        try:
            msg = json.loads(await asyncio.wait_for(b.receive_from(), timeout=0.4))
            if msg.get("type") == "error":
                err = msg
                break
        except asyncio.TimeoutError:
            break
    check("не-хост не может начать партию", err is not None)

    print("\n=== Старт партии ===")
    await send(a, {"action": "start"})
    st_a = await drain(a)
    st_b = await drain(b)
    check("партия началась", st_a["in_lobby"] is False)
    check("каждому роздано 6 карт", len(st_a["game"]["my_hand"]) == 6)
    check("козырь определён", bool(st_a["game"]["trump_suit"]))
    check("в колоде осталось 24", st_a["game"]["deck_count"] == 24)

    print("\n=== Приватность рук ===")
    hand_a = {(c["rank"], c["suit"]) for c in st_a["game"]["my_hand"]}
    hand_b = {(c["rank"], c["suit"]) for c in st_b["game"]["my_hand"]}
    check("руки у игроков разные", hand_a != hand_b)
    check("чужие карты не раскрыты", all("hand" not in p for p in st_a["game"]["players"]))
    check("видно лишь количество чужих карт",
          all(p["card_count"] == 6 for p in st_a["game"]["players"]))

    print("\n=== Ход не в свою очередь ===")
    attacker_pid = st_a["game"]["attacker"]
    att_comm, att_state, def_comm = (
        (a, st_a, b) if attacker_pid == st_a["me"] else (b, st_b, a)
    )
    def_state = st_b if att_comm is a else st_a

    await send(def_comm, {"action": "attack", "card": def_state["game"]["my_hand"][0]})
    err = None
    for _ in range(4):
        try:
            msg = json.loads(await asyncio.wait_for(def_comm.receive_from(), timeout=0.4))
            if msg.get("type") == "error":
                err = msg
                break
        except asyncio.TimeoutError:
            break
    check("защищающийся не может атаковать первым", err is not None)

    print("\n=== Атака и защита ===")
    card = att_state["game"]["my_hand"][0]
    await send(att_comm, {"action": "attack", "card": card})
    s1 = await drain(att_comm)
    s2 = await drain(def_comm)
    check("карта появилась на столе", len(s1["game"]["table"]) == 1)
    check("оба видят стол", len(s2["game"]["table"]) == 1)
    check("у атакующего стало 5 карт", len(s1["game"]["my_hand"]) == 5)

    print("\n=== Недопустимое подкидывание ===")
    table_rank = s1["game"]["table"][0]["attack"]["rank"]
    wrong = next(
        (c for c in s1["game"]["my_hand"] if c["rank"] != table_rank), None
    )
    if wrong:
        await send(att_comm, {"action": "attack", "card": wrong})
        err = None
        for _ in range(4):
            try:
                msg = json.loads(await asyncio.wait_for(att_comm.receive_from(), timeout=0.4))
                if msg.get("type") == "error":
                    err = msg
                    break
            except asyncio.TimeoutError:
                break
        check("карту другого достоинства подкинуть нельзя", err is not None)

    print("\n=== Взятие карт и закрытие захода ===")
    before = len(s2["game"]["my_hand"])
    await send(def_comm, {"action": "take"})
    s_def = await drain(def_comm)
    s_att = await drain(att_comm)

    # Заход закроется сразу, если атакующему нечего подкинуть,
    # иначе он должен включить движок готовности.
    if s_def["game"]["table"]:
        check("пока есть чем подкидывать — стол не закрыт", s_def["game"]["defender_took"] is True)
        await send(att_comm, {"action": "ready"})
        s_att = await drain(att_comm)
        s_def = await drain(def_comm)
    else:
        check("нечего подкидывать — заход закрылся сам", True)

    check("стол очищен", len(s_att["game"]["table"]) == 0)
    check("защищающийся забрал карты со стола", len(s_def["game"]["my_hand"]) > before)
    check("колода уменьшилась после добора", s_att["game"]["deck_count"] < 24)

    print("\n=== Обрыв связи ставит партию на паузу ===")
    await b.disconnect()
    await asyncio.sleep(0.3)
    s_pause = await drain(a)
    if s_pause:
        check("партия на паузе", s_pause["game"]["paused"] is True)
        check("сервер называет отключившегося",
              s_pause["game"]["disconnected"][0]["name"] == "Максим")
    else:
        check("партия на паузе", False)
        check("сервер называет отключившегося", False)

    print("\n=== Возврат игрока на своё место ===")
    b2, ok_b2 = await connect("TEST01", "Максим", char="mei")
    check("игрок переподключился", ok_b2)
    s_back = await drain(b2)
    check("партия продолжается", s_back["game"]["paused"] is False)
    check("карты на месте, а не потеряны", len(s_back["game"]["my_hand"]) > 0)
    check("это то же самое место", s_back["me"] == st_b["me"])

    print("\n=== Изоляция комнат ===")
    c, _ = await connect("TEST02", "Оля")
    st_c = await recv(c)
    check("новая комната пуста и независима", len(st_c["lobby"]["seats"]) == 1)
    check("код комнаты свой", st_c["lobby"]["code"] == "TEST02")

    for comm in (a, b2, c):
        await comm.disconnect()

    passed = sum(1 for _, ok in results if ok)
    total = len(results)
    print(f"\n{'=' * 44}")
    print(f"Пройдено: {passed}/{total}")
    if passed < total:
        print("Провалились:")
        for name, ok in results:
            if not ok:
                print(f"  - {name}")
    return passed == total


if __name__ == "__main__":
    asyncio.run(main())
