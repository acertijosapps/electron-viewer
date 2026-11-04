const $ = (s) => document.querySelector(s);
const log = (text) => {
  $('#log').textContent = text;
  console.log(text);
};

let clicks = 0;
$('#count').onclick = () => {
  clicks++;
  $('#count').textContent = `Clicked ${clicks} time${clicks === 1 ? '' : 's'}`;
  log(`click ${clicks}`);
};
$('#count').ondblclick = () => log('double click');
$('#dialog').onclick = async () => log(`dialog → button ${(await window.example.dialog()).response}`);
$('#new-window').onclick = () => window.example.newWindow();
$('#name').oninput = (e) => ($('#echo').textContent = e.target.value);
$('#name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') log(`enter: ${e.target.value}`);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.example.contextMenu();
});
window.example.onMenu((label) => log(`menu: ${label}`));

$('#list').append(
  ...Array.from({ length: 60 }, (_, i) => Object.assign(document.createElement('li'), { textContent: `Item ${i + 1}` })),
);
$('aside').addEventListener('scroll', (e) => log(`scrollTop ${Math.round(e.target.scrollTop)}`));

const box = $('#box');
box.addEventListener('pointerdown', (e) => {
  const board = $('#board').getBoundingClientRect();
  const dx = e.clientX - box.offsetLeft - board.left;
  const dy = e.clientY - box.offsetTop - board.top;
  box.setPointerCapture(e.pointerId);
  box.onpointermove = (m) => {
    box.style.left = `${m.clientX - board.left - dx}px`;
    box.style.top = `${m.clientY - board.top - dy}px`;
  };
  box.onpointerup = () => {
    box.onpointermove = null;
    log(`dropped at ${box.offsetLeft}, ${box.offsetTop}`);
  };
});

// Touch: long press propio (como en las apps touch-first) y pinch con dos dedos.
const distance = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
let pressTimer = null;
let pinch = null;
window.addEventListener('touchstart', (e) => {
  clearTimeout(pressTimer);
  if (e.touches.length === 2) pinch = { start: distance(e.touches), scale: 1 };
  else pressTimer = setTimeout(() => log('long press'), 600);
});
window.addEventListener('touchmove', (e) => {
  clearTimeout(pressTimer);
  if (pinch && e.touches.length === 2) pinch.scale = distance(e.touches) / pinch.start;
});
window.addEventListener('touchend', () => {
  clearTimeout(pressTimer);
  if (pinch) log(`pinch ${pinch.scale.toFixed(2)}×`);
  pinch = null;
});
window.addEventListener('pointerdown', (e) => e.pointerType === 'touch' && console.log('touch at', Math.round(e.clientX), Math.round(e.clientY)));
