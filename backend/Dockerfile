# Лёгкий образ — на бесплатном тарифе важно уложиться в 512 МБ RAM
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# Хостинг подставляет свой порт через переменную PORT.
# Daphne поднимает ASGI-приложение — именно оно обслуживает WebSocket.
CMD daphne -b 0.0.0.0 -p ${PORT} durak_server.asgi:application
