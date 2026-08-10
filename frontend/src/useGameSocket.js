import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Соединение с игровым сервером.
 *
 * Адрес сервера берётся из того же хоста, откуда открыт сайт — благодаря этому
 * с телефона можно зайти на http://192.168.x.x:5173 и WebSocket сам подключится
 * к http://192.168.x.x:8000, без правки конфигов.
 */
export function serverBase() {
  // На проде фронт и бэкенд живут на РАЗНЫХ доменах, поэтому адрес сервера
  // задаётся переменной окружения при сборке (VITE_SERVER_URL).
  // Локально её нет — тогда берём текущий хост и порт 8000, чтобы работал
  // заход с телефона по IP без правки конфигов.
  const explicit = import.meta?.env?.VITE_SERVER_URL;
  if (explicit) {
    return explicit.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
  const host = window.location.hostname;
  const port = import.meta?.env?.VITE_WS_PORT || '8000';
  return `${host}:${port}`;
}

// Защищённое соединение нужно всегда, когда сам сервер под HTTPS —
// браузер заблокирует обычный ws:// со страницы, открытой по https://
export function wsProtocol() {
  const explicit = import.meta?.env?.VITE_SERVER_URL;
  if (explicit) return explicit.startsWith('https://') ? 'wss' : 'ws';
  return window.location.protocol === 'https:' ? 'wss' : 'ws';
}

export function useGameSocket({ code, name, charId, maxPlayers, translatable, pairDefense, enabled }) {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | connecting | open | closed | error
  const [error, setError] = useState(null);
  const [lastEvent, setLastEvent] = useState(null);
  const [latency, setLatency] = useState(null);
  const socketRef = useRef(null);
  const retryRef = useRef(null);
  const attemptRef = useRef(0);
  const shouldRun = enabled && code && name;

  useEffect(() => {
    if (!shouldRun) return undefined;

    let closedByUs = false;

    const connect = () => {
      const proto = wsProtocol();
      const params = new URLSearchParams({
        name,
        char: charId || 'jack',
        max: String(maxPlayers || 4),
        translatable: translatable ? '1' : '0',
        pair: pairDefense ? '1' : '0',
      });
      const url = `${proto}://${serverBase()}/ws/room/${code}/?${params}`;

      setStatus('connecting');
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        setStatus('open');
        setError(null);
        attemptRef.current = 0;
      };

      ws.onmessage = (evt) => {
        let msg;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.type === 'ping') {
          // Отвечаем сразу — иначе прокси между странами оборвёт «тихое» соединение
          ws.send(JSON.stringify({ action: 'pong', t: msg.t }));
          return;
        }
        if (msg.type === 'latency') {
          setLatency(msg.ms);
          return;
        }
        if (msg.type === 'state') {
          setState(msg);
          if (msg.last_event) setLastEvent({ ...msg.last_event, at: Date.now() });
        } else if (msg.type === 'error') {
          setError({ message: msg.message, at: Date.now() });
          // ошибки правил не рвут соединение — просто показываем их игроку
        }
      };

      ws.onerror = () => setStatus('error');

      ws.onclose = () => {
        setStatus('closed');
        if (!closedByUs) {
          // Связь могла оборваться (телефон заснул, Wi-Fi мигнул, сменилась сеть).
          // Пробуем снова с нарастающей паузой, чтобы не забивать сервер.
          attemptRef.current = Math.min(attemptRef.current + 1, 6);
          const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15000);
          retryRef.current = setTimeout(connect, delay);
        }
      };
    };

    connect();

    return () => {
      closedByUs = true;
      clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [shouldRun, code, name, charId, maxPlayers, translatable, pairDefense]);

  const send = useCallback((payload) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const actions = {
    start: () => send({ action: 'start' }),
    restart: () => send({ action: 'restart' }),
    attack: (card) => send({ action: 'attack', card }),
    defend: (card, slot) => send({ action: 'defend', card, slot }),
    translate: (card) => send({ action: 'translate', card }),
    showTrump: (card) => send({ action: 'show_trump', card }),
    take: () => send({ action: 'take' }),
    ready: () => send({ action: 'ready' }),
    unready: () => send({ action: 'unready' }),
  };

  return { state, status, error, lastEvent, latency, send, actions };
}
