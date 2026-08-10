"""
Настройки Django для сервера игры «Дурак».

Специально настроено под локальное тестирование в одной Wi-Fi сети:
телефон и ноутбук заходят на один и тот же адрес вида http://192.168.x.x:8000
Redis НЕ нужен — используется InMemoryChannelLayer (её достаточно для одного процесса).
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

import os

SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-secret-key-change-in-production")
DEBUG = os.environ.get("DEBUG", "1") == "1"

# Локально пускаем всех (нужно для теста с телефона по IP).
# На хостинге задай ALLOWED_HOSTS через переменную окружения.
_hosts = os.environ.get("ALLOWED_HOSTS", "")
ALLOWED_HOSTS = [h.strip() for h in _hosts.split(",") if h.strip()] or ["*"]

# Хостинг работает за HTTPS-прокси — без этого Django не поймёт,
# что соединение защищённое, и wss может отвалиться.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
USE_X_FORWARDED_HOST = True

# Разрешённые источники WebSocket. На проде укажи адрес фронта,
# иначе браузер заблокирует соединение с чужого домена.
_origins = os.environ.get("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _origins.split(",") if o.strip()]

INSTALLED_APPS = [
    "daphne",  # должен идти ДО staticfiles, иначе runserver не станет ASGI
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "django.contrib.staticfiles",
    "game",
]

MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "durak_server.urls"
ASGI_APPLICATION = "durak_server.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    },
]

# Комнаты живут в памяти процесса, БД для игры не нужна.
DATABASES = {}

# Слой каналов.
# Локально хватает памяти процесса. На хостинге ОБЯЗАТЕЛЕН Redis: без него
# при нескольких воркерах игроки одной комнаты попадут в разные процессы
# и просто не увидят друг друга.
REDIS_URL = os.environ.get("REDIS_URL", "")

if REDIS_URL:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL]},
        }
    }
else:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        }
    }

# Сколько секунд ждать вернувшегося игрока, прежде чем предложить новую партию
RECONNECT_GRACE_SECONDS = int(os.environ.get("RECONNECT_GRACE", "120"))

STATIC_URL = "static/"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
