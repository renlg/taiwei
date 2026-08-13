const messages = document.querySelector('#messages');
const composer = document.querySelector('#composer');
const input = document.querySelector('#input');
const send = document.querySelector('#send');
const stop = document.querySelector('#stop');
let controller;

function addLine(className, text = '') {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  messages.append(element);
  messages.scrollTop = messages.scrollHeight;
  return element;
}

function setRunning(running) {
  send.disabled = running;
  stop.disabled = !running;
  input.disabled = running;
}

function parseEvent(block) {
  let event = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return;
  try { return { event, data: JSON.parse(data.join('\n')) }; } catch { return; }
}

async function submit(message) {
  addLine('message user', message);
  const answer = addLine('message assistant');
  controller = new AbortController();
  setRunning(true);
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error((await response.json()).error || `Request failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = done ? '' : blocks.pop() || '';
      for (const block of blocks) {
        const item = parseEvent(block);
        if (!item) continue;
        if (item.event === 'token') answer.textContent += item.data.text;
        else if (item.event === 'tool') addLine('activity', `🔧 ${item.data.name} ${JSON.stringify(item.data.args)}`);
        else if (item.event === 'tool_result') addLine('activity', `✓ ${item.data.name} finished`);
        else if (item.event === 'done' && !answer.textContent) answer.textContent = item.data.text;
        else if (item.event === 'error') throw new Error(item.data.message);
        messages.scrollTop = messages.scrollHeight;
      }
      if (done) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') answer.textContent += `${answer.textContent ? '\n\n' : ''}Error: ${error.message}`;
    else if (!answer.textContent) answer.textContent = 'Turn stopped.';
  } finally {
    controller = undefined;
    setRunning(false);
    input.focus();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || controller) return;
  input.value = '';
  submit(message);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stop.addEventListener('click', async () => {
  await fetch('/api/stop', { method: 'POST' }).catch(() => {});
  controller?.abort();
});
