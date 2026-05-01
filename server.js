const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Разрешаем запросы с iOS-приложения
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true })); // для UptimeRobot webhook'ов

// ===== Telegram-уведомления через UptimeRobot webhook =====
async function sendTelegramAlert(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('Telegram env vars не заданы — пропускаю отправку');
    return;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!resp.ok) {
      console.error('Telegram API error:', resp.status, await resp.text());
    }
  } catch (e) {
    console.error('Telegram fetch error:', e.message);
  }
}

// Принимает GET или POST от UptimeRobot, поддерживает placeholders в query/body.
app.all('/uptime-webhook', async (req, res) => {
  const data    = { ...req.query, ...req.body };
  const monitor = data.monitor      || 'pen-serv';
  const status  = (data.status || '').toLowerCase();
  const details = data.details     || '';

  const emoji = status === 'down' ? '🔴' : status === 'up' ? '🟢' : '⚠️';
  const text  = `${emoji} ${monitor}: ${status || 'unknown'}\n${details}`.trim();

  console.log('UptimeRobot webhook:', text);
  await sendTelegramAlert(text);
  res.status(200).send('ok');
});

// Хранилище всех точек (для новых подключений)
let allDots = [];
let force252 = false;

// Ограничение истории — спасает память на длинной дистанции.
const MAX_DOTS_HISTORY = 50_000;

// POST-эндпоинт для пакета (массива) точек от ручки
app.post('/api/dots', (req, res) => {
  const dotsArray = req.body;

  // Проверяем, что пришел именно массив
  if (Array.isArray(dotsArray)) {
    let validDotsCount = 0;

    // "Разборщик": дробим буфер и обрабатываем каждую точку
    dotsArray.forEach(dot => {
      if (dot && 'x' in dot && 'y' in dot && 'dotType' in dot) {
        allDots.push(dot);
        if (allDots.length > MAX_DOTS_HISTORY) {
          allDots = allDots.slice(-MAX_DOTS_HISTORY);
        }
        validDotsCount++;
        
        // Рассылаем каждую точку всем подключенным клиентам
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'new_dot', dot }));
            client.send(JSON.stringify({ type: 'activity_dot' }));
          }
        });
      }
    });
    
    console.log(`Получен пакет из ${dotsArray.length} точек. Успешно добавлено: ${validDotsCount}`);
    res.status(200).json({ success: true, added: validDotsCount });
    
  } else {
    // Если пришел не массив, отдаем ошибку
    res.status(400).json({ error: 'Invalid data format. Expected an array of dots.' });
  }
});

app.post('/health', (req, res) => {
  // Опционально: можно прочитать и залогировать connectedPen
  const { connectedPen } = req.body;
  
  console.log('Получен POST /health от ручки:', connectedPen || 'без идентификатора', new Date().toISOString());
  
  if (connectedPen === "NaN") {
    const statusCode = force252 ? 252 : 200;
    res.status(statusCode).send('OK');
    force252 = false
  } else {
    res.status(200).send('OK');
  }

  // Уведомляем все подключённые браузеры
  wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ 
              type: 'activity_health',
              connectedPen: connectedPen || null,   // можно передать дальше в UI
              timestamp: new Date().toISOString(),
              force252: force252
          }));
      }
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
      try {
          const data = JSON.parse(message);

          if (data.type === 'set_force252') {
              force252 = !!data.value;  // true/false
              console.log(`force252 изменён на ${force252} по команде из браузера`);

              // Можно сразу уведомить всех о новом состоянии (опционально)
              wss.clients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                      client.send(JSON.stringify({
                          type: 'force252_changed',
                          value: force252
                      }));
                  }
              });
          } else if (data.type === 'clear_all') {
              allDots = [];
              console.log('allDots очищен по команде из браузера');
              // Транслируем всем дашбордам, чтобы они тоже очистили холст.
              wss.clients.forEach(client => {
                  if (client.readyState === WebSocket.OPEN) {
                      client.send(JSON.stringify({ type: 'cleared' }));
                  }
              });
          } else if (data.type === 'clear_page') {
              const pageNum = parseInt(data.page);
              if (Number.isFinite(pageNum) && pageNum >= 1 && pageNum <= 10) {
                  const before = allDots.length;
                  allDots = allDots.filter(d => (d.page || 1) !== pageNum);
                  console.log(`Страница ${pageNum} очищена. Удалено точек: ${before - allDots.length}`);
                  wss.clients.forEach(client => {
                      if (client.readyState === WebSocket.OPEN) {
                          client.send(JSON.stringify({ type: 'page_cleared', page: pageNum }));
                      }
                  });
              }
          }
      } catch (e) {
          console.error('Ошибка парсинга WS-сообщения:', e);
      }
  });
});

// Главная страница с холстом для просмотра + индикаторы
app.get('/', (req, res) => {
    res.send(`
  <!DOCTYPE html>
  <html lang="ru">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live письмо с NeoSmartpen R1</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
      body {
        background: #f0f0f0;
        font-family: system-ui, -apple-system, sans-serif;
        color: #1a1a1a;
        display: grid;
        grid-template-columns: 210px 1fr 110px;
        grid-template-rows: auto 1fr auto;
        grid-template-areas:
          "header  header  header"
          "sidebar canvas  pages"
          "footer  footer  footer";
        gap: 8px;
        padding: 8px;
      }

      /* Header */
      .header {
        grid-area: header;
        display: flex; align-items: center; gap: 10px;
        padding: 4px 12px;
      }
      .header h3 { margin: 0; color: #333; flex: 1; font-size: 16px; }
      .header button {
        padding: 8px 14px; font-size: 13px; border: none; border-radius: 6px;
        cursor: pointer; color: white; transition: all 0.2s;
      }
      .header button:hover { filter: brightness(1.12); transform: translateY(-1px); }
      #autoPageSwitchBtn { background: #28a745; }
      #force252Btn       { background: #999999; }

      /* Sidebar */
      .sidebar {
        grid-area: sidebar;
        display: flex; flex-direction: column; gap: 10px;
      }
      #stats-panel {
        background: rgba(30, 30, 35, 0.92);
        color: #e8e8e8;
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 12px;
        padding: 10px 14px;
        border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.18);
      }
      .stats-row { display: flex; justify-content: space-between; gap: 14px; line-height: 1.7; }
      .stats-label { color: #a0a0a8; }

      #indicators-container {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        padding: 10px 8px;
        background: rgba(255,255,255,0.85);
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      }
      .indicator-cell {
        display: flex; flex-direction: column; align-items: center; gap: 4px;
      }
      .indicator-name {
        font-size: 10px; color: #555;
        text-transform: uppercase; letter-spacing: 0.5px;
      }
      .indicator {
        width: 32px; height: 32px;
        border-radius: 50%;
        box-shadow: 0 3px 10px rgba(0,0,0,0.15);
        transition: background-color 0.3s ease, transform 0.2s ease;
        position: relative;
      }
      .indicator .timer-label {
        position: absolute; top: -16px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.7); color: white; font-size: 9px;
        padding: 1px 5px; border-radius: 6px; opacity: 0;
        transition: opacity 0.3s; pointer-events: none; white-space: nowrap;
      }
      .indicator.active .timer-label { opacity: 1; }
      #ws-indicator     { background-color: red; }
      #health-indicator { background-color: red; }
      #dot-indicator    { background-color: #aaa; }

      /* Pulse-анимация при активности */
      @keyframes ind-pulse {
        0%   { transform: scale(1);    box-shadow: 0 0 0 0   rgba(40,167,69,0.55); }
        50%  { transform: scale(1.18); box-shadow: 0 0 0 8px rgba(40,167,69,0);    }
        100% { transform: scale(1);    box-shadow: 0 0 0 0   rgba(40,167,69,0);    }
      }
      .indicator.pulse { animation: ind-pulse 0.5s ease-out; }

      /* Canvas */
      canvas {
        grid-area: canvas;
        background: white;
        box-shadow: 0 8px 30px rgba(0,0,0,0.15);
        border-radius: 8px;
        width: 100%; height: 100%;
        display: block;
      }

      /* Page buttons (правая колонка) */
      .page-buttons {
        grid-area: pages;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: center;
        padding: 4px;
      }
      .page-buttons button {
        width: 44px; height: 44px;
        padding: 0; font-size: 16px; font-weight: bold;
        background: #444; color: white;
        border: none; border-radius: 50%;
        cursor: pointer; transition: all 0.2s;
        box-shadow: 0 3px 10px rgba(0,0,0,0.2);
      }
      .page-buttons button:hover { transform: translateY(-1px); box-shadow: 0 5px 14px rgba(0,123,255,0.5); }
      .page-buttons button.active { box-shadow: 0 0 0 3px rgba(0,123,255,0.8); }
      .page-buttons button.written { background: #00aa7b; }
      .page-buttons .clear-current { background: #d6a40f !important; margin-top: 8px; font-size: 13px; }
      .page-buttons .clear-all     { background: #c0392b !important; }

      /* Footer */
      .footer {
        grid-area: footer;
        display: flex; align-items: center; gap: 12px;
        padding: 6px 12px;
        background: rgba(255,255,255,0.85);
        border-radius: 8px;
        font-size: 13px; color: #555;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
      #penStatus { font-weight: 600; }
      #penStatus.connected { color: #28a745; }

      /* ===== Mobile / узкие экраны ===== */
      @media (max-width: 900px) {
        html, body { overflow: auto; }
        body {
          grid-template-columns: 1fr;
          grid-template-rows: auto auto auto auto auto;
          grid-template-areas:
            "header"
            "sidebar"
            "canvas"
            "pages"
            "footer";
          height: auto;
          min-height: 100vh;
        }
        .header { flex-wrap: wrap; }
        .header h3 { width: 100%; flex: none; font-size: 14px; }

        .sidebar { flex-direction: row; flex-wrap: wrap; }
        #stats-panel { flex: 1; min-width: 200px; }
        #indicators-container { flex: 1; min-width: 180px; }

        canvas {
          aspect-ratio: 70 / 90;
          height: auto !important;
          max-height: 75vh;
        }

        .page-buttons {
          flex-direction: row;
          flex-wrap: wrap;
          gap: 6px;
          justify-content: center;
        }
        .page-buttons button {
          width: 38px; height: 38px;
          font-size: 14px;
        }
        .page-buttons .clear-current,
        .page-buttons .clear-all {
          margin-top: 0;
          width: auto;
          padding: 0 12px;
        }
      }
    </style>
  </head>
  <body>
    <div class="header">
      <h3>NeoSmartpen R1 — live</h3>
      <button id="autoPageSwitchBtn" onclick="switchAutoPageSwitch()">AutoPageSwitch</button>
      <button id="force252Btn" onclick="toggleForce252()">Переподключить</button>
    </div>

    <div class="sidebar">
      <div id="stats-panel">
        <div class="stats-row"><span class="stats-label">Точек</span><span id="stat-total">0</span></div>
        <div class="stats-row"><span class="stats-label">Точек/сек</span><span id="stat-rate">0.0</span></div>
        <div class="stats-row"><span class="stats-label">Последняя</span><span id="stat-last">—</span></div>
        <div class="stats-row"><span class="stats-label">WS uptime</span><span id="stat-wsup">—</span></div>
      </div>
      <div id="indicators-container">
        <div class="indicator-cell">
          <div id="ws-indicator" class="indicator" title="WebSocket дашборд ↔ сервер"></div>
          <div class="indicator-name">WS</div>
        </div>
        <div class="indicator-cell">
          <div id="health-indicator" class="indicator" title="Heartbeat от приложения каждые 5 с"><div class="timer-label">0s</div></div>
          <div class="indicator-name">Health</div>
        </div>
        <div class="indicator-cell">
          <div id="dot-indicator" class="indicator" title="Точки от ручки"><div class="timer-label">0s</div></div>
          <div class="indicator-name">Dots</div>
        </div>
      </div>
    </div>

    <canvas id="canvas"></canvas>

    <div class="page-buttons">
      <button onclick="goToPage(1)">1</button>
      <button onclick="goToPage(2)">2</button>
      <button onclick="goToPage(3)">3</button>
      <button onclick="goToPage(4)">4</button>
      <button onclick="goToPage(5)">5</button>
      <button onclick="goToPage(6)">6</button>
      <button onclick="goToPage(7)">7</button>
      <button onclick="goToPage(8)">8</button>
      <button onclick="goToPage(9)">9</button>
      <button onclick="goToPage(10)">10</button>
      <button class="clear-current" onclick="clearCurrentPageGlobal()" title="Очистить ТОЛЬКО эту страницу на сервере и всех дашбордах">C₁</button>
      <button class="clear-all" onclick="clearAllGlobal()" title="Очистить ВСЁ на сервере и всех дашбордах">C</button>
    </div>

    <div class="footer">
      <span id="penStatus">Pen: —</span>
    </div>

    <script>
      const canvas = document.getElementById('canvas');
      const ctx = canvas.getContext('2d');

      let autoPageSwitch = true;
  
      const PAGE_WIDTH_MM = 70;
      const PAGE_HEIGHT_MM = 90;
  
      let scaleX = 1, scaleY = 1;
      let offsetX = 0, offsetY = 0;
  
      let previousX = null;
      let previousY = null;

      // Индикаторы
      const wsIndicator = document.getElementById('ws-indicator');
      const healthIndicator = document.getElementById('health-indicator');
      const dotIndicator = document.getElementById('dot-indicator');
      const healthTimer = healthIndicator.querySelector('.timer-label');
      const dotTimer = dotIndicator.querySelector('.timer-label');

      let healthTimerId = null;
      let dotTimerId = null;

      function startTimer(indicator, timerLabel, color, currentTimerId) {
        // Если уже идёт таймер — останавливаем его
        if (currentTimerId !== null) {
          clearInterval(currentTimerId);
        }

        // Активируем индикатор + лёгкая pulse-анимация на каждое событие
        indicator.style.backgroundColor = color;
        indicator.classList.add('active');
        pulseIndicator(indicator);
        
        let seconds = 0;
        timerLabel.textContent = seconds + 's';

        // Запускаем новый таймер и сохраняем его ID
        const newIntervalId = setInterval(() => {
          seconds++;
          timerLabel.textContent = seconds + 's';

          if (seconds >= 6) {
            indicator.style.backgroundColor = color == "green" ? '#aaa' : "red";
            
          }

          if (seconds >= 300) {
            clearInterval(newIntervalId);
            indicator.classList.remove('active');
            // Сбрасываем ID
            if (indicator === healthIndicator) healthTimerId = null;
            if (indicator === dotIndicator) dotTimerId = null;
        }       
        }, 1000);

        // Сохраняем новый ID
        if (indicator === healthIndicator) healthTimerId = newIntervalId;
        if (indicator === dotIndicator) dotTimerId = newIntervalId;
      }
      
      const pages = Array.from({ length: 10 }, () => []);
      let currentPageIndex = 0;

      const realPages = [];

      let buffer = [];  // Буфер для точек (чтобы избежать асинхронных скачков)
      let lastTime = 0;  // Для проверки порядка

      // ===== WebSocket с авто-реконнектом =====
      // Backoff: 1с → 2с → 3с → ... → 10с (максимум). После успешного коннекта сбрасывается.
      let ws = null;
      let force252 = false;
      let reconnectAttempt = 0;
      let reconnectTimerId = null;

      function connectWS() {
        if (reconnectTimerId) { clearTimeout(reconnectTimerId); reconnectTimerId = null; }
        const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsHost  = location.host;
        ws = new WebSocket(wsProto + '//' + wsHost);
        wireWS(ws);
      }

      function scheduleReconnect() {
        if (reconnectTimerId) return; // уже запланирован
        reconnectAttempt++;
        const delay = Math.min(reconnectAttempt, 10) * 1000;
        console.log('WS reconnect через ' + delay + 'мс (попытка ' + reconnectAttempt + ')');
        wsIndicator.style.backgroundColor = 'orange';
        reconnectTimerId = setTimeout(() => {
          reconnectTimerId = null;
          connectWS();
        }, delay);
      }

      function wireWS(socket) {
        socket.onopen = () => {
          console.log('WS подключён');
          reconnectAttempt = 0;
          stats.wsConnectedAt = Date.now();
          wsIndicator.style.backgroundColor = 'green';
          // Историю не запрашиваем — стартуем с пустого холста, ждём live-точек.
        };
        socket.onclose = () => {
          console.log('WS закрыт');
          wsIndicator.style.backgroundColor = 'red';
          scheduleReconnect();
        };
        socket.onerror = (e) => {
          console.log('WS error', e);
          // onclose вызовется следом, реконнект там
        };
        socket.onmessage = onWSMessage;
      }

      // Безопасный отправщик (для toggleForce252 и др.)
      function wsSend(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(obj));
        } else {
          console.log('WS не открыт — сообщение пропущено', obj);
        }
      }

      // ===== Stats =====
      const stats = {
        totalDots: 0,
        recentTimestamps: [], // массив времён последних точек для подсчёта dots/sec
        lastDotAt: null,
        wsConnectedAt: null
      };

      function recordDotForStats() {
        stats.totalDots++;
        const now = Date.now();
        stats.lastDotAt = now;
        stats.recentTimestamps.push(now);
        // оставляем только за последние 5 секунд
        const cutoff = now - 5000;
        while (stats.recentTimestamps.length > 0 && stats.recentTimestamps[0] < cutoff) {
          stats.recentTimestamps.shift();
        }
      }

      function updateStatsPanel() {
        const dotsPerSec = (stats.recentTimestamps.length / 5).toFixed(1);
        const lastSeen = stats.lastDotAt
          ? Math.floor((Date.now() - stats.lastDotAt) / 1000) + 'с назад'
          : '—';
        const wsUp = (ws && ws.readyState === WebSocket.OPEN && stats.wsConnectedAt)
          ? Math.floor((Date.now() - stats.wsConnectedAt) / 1000) + 'с'
          : '—';
        document.getElementById('stat-total').textContent = stats.totalDots;
        document.getElementById('stat-rate').textContent  = dotsPerSec;
        document.getElementById('stat-last').textContent  = lastSeen;
        document.getElementById('stat-wsup').textContent  = wsUp;
      }
      setInterval(updateStatsPanel, 500);

      // Кладёт точку в pages[] по её РЕАЛЬНОМУ номеру страницы, а не в currentPageIndex.
      function storeDotInPages(dot) {
        const pageIdx = Math.max(1, Math.min(10, dot.page || 1)) - 1;
        pages[pageIdx].push(dot);
      }
      // Помечает кнопку соответствующей страницы как "written".
      function markPageWritten(pageIdx) {
        document.querySelectorAll('.page-buttons button').forEach(btn => {
          if (parseInt(btn.textContent) === pageIdx + 1) btn.classList.add('written');
        });
      }

      function onWSMessage(event) {
        const data = JSON.parse(event.data);
        if (data.type === 'all_dots') {
          // При первом подключении / реконнекте — обновим локальный кеш pages[]
          // и перерисуем текущую страницу.
          for (let i = 0; i < pages.length; i++) pages[i] = [];
          data.dots.forEach(d => {
            storeDotInPages(d);
            const pageIdx = Math.max(1, Math.min(10, d.page || 1)) - 1;
            markPageWritten(pageIdx);
          });
          // Перерисовываем только точки текущей страницы.
          clearCanvas();
          for (const d of pages[currentPageIndex]) processDot(d);
        } else if (data.type === 'new_dot') {
          storeDotInPages(data.dot);
          const pageIdx = Math.max(1, Math.min(10, data.dot.page || 1)) - 1;
          markPageWritten(pageIdx);
          // Рисуем если: либо автопереключение страниц включено (processDot сам переключит),
          // либо точка пришла на текущую открытую страницу.
          if (autoPageSwitch || pageIdx === currentPageIndex) {
            processDot(data.dot);
          }
        } else if (data.type === 'activity_health') {
          startTimer(healthIndicator, healthTimer, '#007bff', healthTimerId);
          if (data.connectedPen) {
              const penEl = document.getElementById('penStatus');
              const btn = document.getElementById('force252Btn');
              if (penEl) {
                  penEl.textContent = "Pen: " + (data.connectedPen || "—");
                  if (data.connectedPen === "NaN") {
                      penEl.style.color = '#dc3545'; // красный
                      btn.style.background = '#dc3545';
                  } else {
                      penEl.style.color = '#28a745';
                    btn.style.background = '#999999'; 
                  }
                  btn.textContent = "Переподключить";
                  penEl.classList.add('connected');
              }
              // Можно запустить отдельный таймер/анимацию для pen
              //startTimer(penEl, penTimer || 15000, '#28a745', 'penTimerId');
          } else {
              // Если connectedPen не пришло — считаем, что просто сервер жив
              document.getElementById('penStatus').textContent = 'Pen: —';
          }
        } else if (data.type === 'activity_dot') {
          startTimer(dotIndicator, dotTimer, 'green', dotTimerId);
          recordDotForStats();
        } else if (data.type === 'force252_changed') {
            force252 = data.value;
            const btn = document.getElementById('force252Btn');
            if (btn) {
                btn.textContent = force252 ? "Запрос отправлен" : "Переподключить";
                btn.style.background = force252 ? '#6465f3' : '#999999';
            }
        } else if (data.type === 'cleared') {
            // Сервер сказал "очистить всё" — стираем локальное состояние и холст.
            for (let i = 0; i < pages.length; i++) pages[i] = [];
            buffer = [];
            document.querySelectorAll('.page-buttons button').forEach(b => b.classList.remove('written'));
            stats.totalDots = 0;
            stats.recentTimestamps = [];
            stats.lastDotAt = null;
            clearCanvas();
        } else if (data.type === 'page_cleared') {
            // Сервер очистил конкретную страницу.
            const idx = (data.page || 1) - 1;
            if (idx >= 0 && idx < pages.length) {
              pages[idx] = [];
              document.querySelectorAll('.page-buttons button').forEach(btn => {
                if (parseInt(btn.textContent) === idx + 1) btn.classList.remove('written');
              });
              if (idx === currentPageIndex) clearCanvas();
            }
        }
      };

        function processDot(dot) {
            buffer.push(dot);

            // Прямой маппинг: page N ручки → slot N дашборда (1..10).
            // Никакой накопленной истории "realPages" — поведение предсказуемо.
            if (autoPageSwitch) {
                const target = Math.max(1, Math.min(10, dot.page || 1));
                if (target - 1 !== currentPageIndex) {
                    goToPage(target);
                }
            }

            setTimeout(() => {
              buffer.sort((a, b) => a.time - b.time);
              requestAnimationFrame(drawFromBuffer);
            }, 50);

            // Сортируем буфер по time (на случай асинхронного прихода)
            
        }

        function drawFromBuffer() {
            while (buffer.length > 0) {
            const dot = buffer.shift();  // Берём по порядку

            console.log('Time:', dot.time);
            const force = dot.force || 0.5;
            const lineWidth = 0.4 + force * 0.8;

            const x = dot.x * scaleX * 1.1 + offsetX * 0.9;
            const y = dot.y * scaleY * 1 - offsetY * 0.65;

            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            ctx.strokeStyle = getColor((dot.page || 1) - 1);
            ctx.lineWidth = lineWidth;

            if (dot.dotType === 0 || dot.dotType === undefined || previousX === null) {
                previousX = x;
                previousY = y;
            } else {
                ctx.beginPath();
                ctx.moveTo(previousX, previousY);
                ctx.lineTo(x, y);
                ctx.stroke();

                previousX = x;
                previousY = y;

                if (dot.dotType === 2) {
                previousX = null;
                previousY = null;
                }
            }
            }
        }
  
      function resizeCanvas() {
        // Canvas теперь сидит в grid-ячейке, поэтому берём её фактический размер
        // вместо window.innerWidth/Height.
        const rect = canvas.getBoundingClientRect();
        const cssWidth  = Math.max(100, rect.width);
        const cssHeight = Math.max(100, rect.height);

        const dpr = window.devicePixelRatio || 1;

        canvas.width  = cssWidth * dpr;
        canvas.height = cssHeight * dpr;

        ctx.setTransform(1, 0, 0, 1, 0, 0); // сброс предыдущего scale
        ctx.scale(dpr, dpr);

        const ratio = PAGE_WIDTH_MM / PAGE_HEIGHT_MM;
        const extra = 0.95;

        let drawWidth  = cssWidth  * extra;
        let drawHeight = cssHeight * extra;
        if (drawWidth / drawHeight > ratio) drawWidth = drawHeight * ratio;
        else                                drawHeight = drawWidth / ratio;

        scaleX = drawWidth / PAGE_WIDTH_MM;
        scaleY = drawHeight / PAGE_HEIGHT_MM;

        offsetX = (cssWidth  - drawWidth)  / 2;
        offsetY = (cssHeight - drawHeight) / 2;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cssWidth, cssHeight);
        ctx.fillStyle = '#fafafa';
        ctx.fillRect(offsetX, offsetY, drawWidth, drawHeight);
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);

        previousX = null;
        previousY = null;
        // Перерисовываем точки текущей страницы (если переключились/изменили размер).
        for (const dot of pages[currentPageIndex]) processDot(dot);
      }

      window.addEventListener('resize', resizeCanvas);
      // Стартовая инициализация — даём grid'у разложить элементы перед измерением.
      requestAnimationFrame(resizeCanvas);
    
      function clearCanvas() {
        // Только перерисовка холста (без удаления данных в pages[]).
        previousX = null;
        previousY = null;
        resizeCanvas();
      }

      function goToPage(pageNumber) {
        currentPageIndex = pageNumber - 1;
        clearCanvas();
        document.querySelectorAll('.page-buttons button').forEach(btn => {
          btn.classList.remove('active');
          if (parseInt(btn.textContent) === pageNumber) btn.classList.add('active');
        });
        for (const dot of pages[currentPageIndex]) processDot(dot);
      }
      
      function getColor(page) {
        if (page % 8 === 0 || autoPageSwitch) return 'black';
        if (page % 8 === 1) return '#3498db';
        if (page % 8 === 2) return '#2ecc71';
        if (page % 8 === 3) return '#9b59b6';
        if (page % 8 === 4) return '#f1c40f';
        if (page % 8 === 5) return '#e67e22';
        if (page % 8 === 6) return '#1abc9c';
        if (page % 8 === 7) return '#34495e';
      }
      
      function switchAutoPageSwitch() {
        autoPageSwitch = !autoPageSwitch;
        const btn = document.getElementById('autoPageSwitchBtn');
        if (btn) btn.style.background = autoPageSwitch
          ? 'var(--btn-success)'
          : 'var(--btn-danger)';
      }

      function toggleForce252() {
        force252 = true;
        wsSend({ type: 'set_force252', value: force252 });
        
        // Меняем вид кнопки
        const btn = document.getElementById('force252Btn');
        if (force252) {
            btn.textContent = "Переподключение...";
            btn.style.background = '#6565ff';
        } else {
            btn.textContent = "Переподключить";
            btn.style.background = '#999999';
        }
        force252 = false;
      }

      function clearAllGlobal() {
        // Глобальная очистка: сервер сотрёт allDots и пошлёт всем 'cleared'.
        wsSend({ type: 'clear_all' });
      }

      function clearCurrentPageGlobal() {
        // Очистка только текущей страницы на сервере и всех дашбордах.
        wsSend({ type: 'clear_page', page: currentPageIndex + 1 });
      }

      // Pulse-анимация индикатора — вызывается из startTimer на каждое событие.
      function pulseIndicator(indicator) {
        indicator.classList.remove('pulse');
        void indicator.offsetWidth; // force reflow чтобы анимация перезапустилась
        indicator.classList.add('pulse');
      }

      // Помечаем текущую страницу как активную и стартуем WS-соединение.
      goToPage(1);
      connectWS();
    </script>
  </body>
  </html>
    `);
});

// Обработка запроса всех точек
// При подключении дашборда отправляем всю накопленную историю,
// чтобы пользователь видел что было написано до его захода/реконнекта.
// Очистить историю можно кнопкой "C" — она шлёт 'clear_all' и сервер обнуляет allDots.
wss.on('connection', (ws) => {
  console.log('Новый зритель подключён');
  ws.send(JSON.stringify({ type: 'all_dots', dots: allDots }));
  ws.on('close', () => console.log('Зритель отключён'));
});

const PORT = process.env.PORT || 5252;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Сервер запущен!`);
  console.log(`Открой в браузере: http://localhost:${PORT}`);
  console.log(`Или с другого устройства: http://${getLocalIP()}:${PORT}\n`);
});

function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
