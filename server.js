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
      body { margin: 0; background: #f0f0f0; font-family: system-ui, sans-serif; position: relative; }
      canvas { display: block; margin: 5px auto; background: white; box-shadow: 0 8px 30px rgba(0,0,0,0.15); border-radius: 8px; }
      h3 { text-align: center; padding: 1px; color: #333; margin-bottom: 0; }
      button { display: block; margin: 1px auto; padding: 12px 24px; font-size: 18px; background: #007bff; color: white; border: none; border-radius: 8px; cursor: pointer; }
      button:hover { background: #0056b3; }

      /* Контейнер для индикаторов в правом верхнем углу */
      #indicators-container {
        position: fixed;           
        bottom: 40px;             
        right: 240px;               
        display: flex;
        flex-direction: row;       
        gap: 14px;
        z-index: 1000;             
        pointer-events: none;      
      }

      .indicator {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        transition: all 0.3s ease;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-size: 12px;
        font-weight: bold;
      }

    #controls-container {
        position: fixed;
        bottom: 120px;
        right: 350px;
        z-index: 1000;
        display: flex;
        flex-direction: column;       
        align-items: center;
        gap: 1px;
        pointer-events: none;
      }

      .page-buttons {
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        margin: -30px 0;
        pointer-events: auto;
      }
    
      .page-buttons button {
        width: 44px;
        height: 44px;
        padding: 0;
        font-size: 18px;
        font-weight: bold;
        background: #444;
        color: white;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        transition: all 0.2s;
        box-shadow: 0 3px 10px rgba(0,0,0,0.2);
      }
    
      .page-buttons button:hover {
        
        transform: translateY(-2px);
        box-shadow: 0 6px 15px rgba(0,123,255,0.6);
     }
    
     .page-buttons button.active {
        box-shadow: 0 0 0 4px rgba(0,123,255,0.8);
     }
     .page-buttons button.written {
        background: #00aa7b;
     }

      /* Разные размеры */
      #ws-indicator { 
        width: 40px; height: 40px; 
        background-color: red;
      }
      #health-indicator { background-color: red; }
      #dot-indicator { background-color: #aaa; }

      /* Таймер сверху круга */
      .timer-label {
        position: absolute;
        top: -20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.7);
        color: white;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 8px;
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
      }

      .indicator.active .timer-label {
        opacity: 1;
      }
    </style>
  </head>
  <body>
    <h3>Письмо в реальном времени с NeoSmartpen R1</h3>
    <button onclick="switchAutoPageSwitch()" style="background:#28a745">AutoPageSwitch</button>
    <button onclick="toggleForce252()" id="force252Btn" style="background:#999999; margin: 10px auto; display:block;">
  Переподключить
</button>
    <div id="penStatus" class="status-indicator" style="position: fixed; bottom: 10px; right: 310px; z-index: 1000; display: flex;">Pen: —</div>

    <canvas id="canvas"></canvas>
    
    <div id="controls-container">
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
    <button onclick="clearCurrentPage()" style="margin-top:10px; background:red">C</button>
  </div>

    <div id="indicators-container">
      <div id="ws-indicator" class="indicator"></div>
      <div id="health-indicator" class="indicator">
        <div class="timer-label">60s</div>
      </div>
      <div id="dot-indicator" class="indicator">
        <div class="timer-label">60s</div>
      </div>
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

        // Активируем индикатор
        indicator.style.backgroundColor = color;
        indicator.classList.add('active');
        
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

      // WebSocket + основной индикатор (красный/зелёный).
      // Используем wss:// на HTTPS (иначе mixed-content blocking),
      // ws:// на HTTP. Порт берём из location, чтобы работало и локально, и на Render.
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost  = location.host;  // host уже включает порт если он есть
      const ws = new WebSocket(wsProto + '//' + wsHost);

      let force252 = false;
  
      ws.onopen = () => {
        console.log('WS подключён');
        wsIndicator.style.backgroundColor = 'green';
        ws.send(JSON.stringify({ type: 'request_all_dots' }));
      };
  
      ws.onclose = ws.onerror = () => {
        console.log('WS отключён');
        wsIndicator.style.backgroundColor = 'red';
      };
  
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'all_dots') {
          data.dots.forEach(processDot);
          data.dots.forEach(pages[currentPageIndex].push);
          document.querySelectorAll('.page-buttons button').forEach(btn => {
        
            if (parseInt(btn.textContent) === currentPageIndex + 1) {
                btn.classList.add('written');
            }
          });
        } else if (data.type === 'new_dot') {
          processDot(data.dot);
          pages[currentPageIndex].push(data.dot);
          document.querySelectorAll('.page-buttons button').forEach(btn => {
        
            if (parseInt(btn.textContent) === currentPageIndex + 1) {
                btn.classList.add('written');
            }
          });
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
        } else if (data.type === 'force252_changed') {
            force252 = data.value;
            const btn = document.getElementById('force252Btn');
            if (btn) {
                btn.textContent = force252 ? "Запрос отправлен" : "Переподключить";
                btn.style.background = force252 ? '#6465f3' : '#999999';
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
        const padding = 10;
        const cssWidth = window.innerWidth - padding * 2;
        const cssHeight = window.innerHeight - padding * 2;
  
        const dpr = window.devicePixelRatio || 1;
  
        canvas.style.width = cssWidth + 'px';
        canvas.style.height = cssHeight + 'px';
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
  
        ctx.scale(dpr, dpr);
  
        const ratio = PAGE_WIDTH_MM / PAGE_HEIGHT_MM;
  
        const extra = 0.95;  
  
        let drawWidth = cssWidth * extra;
        let drawHeight = cssHeight * extra;
  
        if (drawWidth / drawHeight > ratio) {
          drawWidth = drawHeight * ratio;
        } else {
          drawHeight = drawWidth / ratio;
        }
  
        scaleX = drawWidth / PAGE_WIDTH_MM;
        scaleY = drawHeight / PAGE_HEIGHT_MM;
  
        offsetX =  (cssWidth - drawWidth) / 2;
        offsetY =  (cssHeight - drawHeight) / 2;
  
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cssWidth, cssHeight);
        ctx.fillStyle = '#fafafa';
        ctx.fillRect(offsetX, offsetY, drawWidth, drawHeight);
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.strokeRect(offsetX, offsetY, drawWidth, drawHeight);
  
        previousX = null;
        previousY = null;
        allDots.forEach(processDot);
      }

      window.onresize = resizeCanvas;
      resizeCanvas();
    
      function clearCanvas() {
        allDots = [];
        previousX = null;
        previousY = null;
        resizeCanvas();
      }

      function goToPage(pageNumber) {
        currentPageIndex = pageNumber - 1;
        clearCanvas();

        document.querySelectorAll('.page-buttons button').forEach(btn => {
        btn.classList.remove('active');
        if (parseInt(btn.textContent) === pageNumber) {
            btn.classList.add('active');
        }
        });

        for (const dot of pages[currentPageIndex]) {
            processDot(dot);
        }
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
        document.querySelectorAll('button').forEach(btn => {
        if (btn.textContent == "AutoPageSwitch") {
            btn.style.background = autoPageSwitch ? '#28a745' : '#dc3545';
        }
        });
      }

      function toggleForce252() {
        force252 = true;
        
        // Отправляем команду серверу
        ws.send(JSON.stringify({
            type: 'set_force252',
            value: force252
        }));
        
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

      function clearCurrentPage() { 
        pages[currentPageIndex] = [];
        clearCanvas();
        document.querySelectorAll('.page-buttons button').forEach(btn => {
        
        if (parseInt(btn.textContent) === currentPageIndex + 1) {
            btn.classList.remove('written');
        }
        });
      }
    </script>
  </body>
  </html>
    `);
});

// Обработка запроса всех точек
wss.on('connection', (ws) => {
  console.log('Новый зритель подключён');
  ws.send(JSON.stringify({ type: 'all_dots', dots: allDots }));

  ws.on('message', (message) => {
    const data = JSON.parse(message);
    if (data.type === 'request_all_dots') {
      ws.send(JSON.stringify({ type: 'all_dots', dots: allDots }));
    }
  });
  
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
