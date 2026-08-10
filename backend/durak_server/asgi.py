"""
Точка входа ASGI.

ВАЖНО: маршруты WebSocket подключаются ЛЕНИВО, уже после того как Django
полностью загрузил приложения. Если импортировать game.routing на уровне
модуля, под Daphne с автоперезагрузкой пакет game может оказаться ещё
не до конца инициализирован — и импорт падает с невнятным
"cannot import name 'consumers' from 'game'".
"""

import os

from channels.routing import ProtocolTypeRouter, URLRouter
from django.core.asgi import get_asgi_application
from django.urls import re_path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "durak_server.settings")

django_asgi_app = get_asgi_application()


def _websocket_router():
    """Импортируем consumers только в момент первого обращения."""
    from game import consumers

    return URLRouter(
        [
            re_path(
                r"^ws/room/(?P<code>[A-Za-z0-9]{4,8})/$",
                consumers.RoomConsumer.as_asgi(),
            )
        ]
    )


class LazyWebsocketRouter:
    """Откладывает создание роутера до первого WebSocket-соединения."""

    def __init__(self):
        self._router = None

    async def __call__(self, scope, receive, send):
        if self._router is None:
            self._router = _websocket_router()
        return await self._router(scope, receive, send)


application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        # Без AllowedHostsOriginValidator — фронт крутится на другом порту,
        # а для локального теста так удобнее. На проде валидатор стоит вернуть.
        "websocket": LazyWebsocketRouter(),
    }
)
