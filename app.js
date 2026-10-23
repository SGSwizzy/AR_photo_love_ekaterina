const $ = (id) => document.getElementById(id);
const home = $('home');
const cameraView = $('camera-view');
const startButton = $('start-camera');
const arVideo = $('ar-video');
const dialog = $('video-dialog');
const player = $('player');
const status = $('camera-status');
let scenes = [];
let engine = null;
let library = null;
let activeTarget = null;
let session = 0;
let running = false;
let textures = [];
let meshes = [];
let videoTexture = null;
let noticeTimer;

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 8500);
}

function openVideo(scene = null) {
  const film = !scene;
  const src = film ? './assets/our-multiverse.mp4' : scene.video;
  $('video-title').textContent = film ? 'Наши мультвселенные' : scene.name;
  player.pause();
  player.src = src;
  player.poster = film ? './assets/photos/02.jpg' : scene.image;
  player.loop = !film;
  player.muted = !film;
  $('download-clip').href = src;
  $('download-clip').download = film ? 'Наши мультвселенные.mp4' : `${scene.name}.mp4`;
  dialog.showModal();
  player.play().catch(() => {}); // Native controls remain available if Safari requests a tap.
}

function closeVideo() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  if (dialog.open) dialog.close();
}

async function loadScenes() {
  startButton.disabled = true;
  try {
    const response = await fetch('./scenes.json');
    if (!response.ok) throw new Error('Collection unavailable');
    scenes = await response.json();
    if (scenes.length !== 15) throw new Error('Incomplete collection');
    const fragment = document.createDocumentFragment();
    for (const scene of scenes) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'photo-card';
      card.setAttribute('aria-label', `Посмотреть анимацию: ${scene.name}`);
      const image = document.createElement('img');
      image.src = scene.thumbnail;
      image.alt = `Мы во вселенной «${scene.name}»`;
      image.loading = 'eager';
      image.width = 360;
      image.height = 640;
      const caption = document.createElement('div');
      caption.className = 'card-caption';
      const name = document.createElement('b');
      name.textContent = scene.name;
      const number = document.createElement('span');
      number.textContent = String(scene.id).padStart(2, '0');
      caption.append(name, number);
      card.append(image, caption);
      card.addEventListener('click', () => openVideo(scene));
      fragment.append(card);
    }
    $('photo-grid').replaceChildren(fragment);
    $('photo-grid').setAttribute('aria-busy', 'false');
    startButton.disabled = false;
  } catch (error) {
    $('photo-grid').setAttribute('aria-busy', 'false');
    const retry = document.createElement('button');
    retry.className = 'button primary';
    retry.textContent = 'Загрузить фотографии ещё раз';
    retry.addEventListener('click', loadScenes);
    $('photo-grid').replaceChildren(retry);
    notice('Не удалось загрузить коллекцию. Проверь интернет и попробуй ещё раз.');
  }
}

async function initializeEngine() {
  library ??= Promise.all([
    import('three'),
    import('./vendor/mind-ar/dist/mindar-image-three.prod.js'),
  ]);
  const [THREE, { MindARThree }] = await library;
  if (engine) return engine;
  const ar = new MindARThree({
    container: $('ar-container'),
    imageTargetSrc: new URL('./assets/targets.mind', window.location.href).href,
    maxTrack: 1,
    uiLoading: 'no', uiScanning: 'no', uiError: 'no',
    warmupTolerance: 3, missTolerance: 7,
    filterMinCF: 0.001, filterBeta: 1000,
  });
  ar.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  videoTexture = new THREE.VideoTexture(arVideo);
  videoTexture.colorSpace = THREE.SRGBColorSpace;
  const loader = new THREE.TextureLoader();
  textures = scenes.map((scene) => {
    const texture = loader.load(scene.image);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  });
  meshes = scenes.map((scene, index) => {
    const anchor = ar.addAnchor(index);
    const material = new THREE.MeshBasicMaterial({ map: textures[index], toneMapped: false });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, scene.height / scene.width), material);
    anchor.group.add(plane);
    anchor.onTargetFound = () => found(index);
    anchor.onTargetLost = () => lost(index);
    return plane;
  });
  engine = ar;
  return ar;
}

function found(index) {
  if (!running) return;
  activeTarget = index;
  const scene = scenes[index];
  status.textContent = scene.name;
  $('camera-hint').textContent = 'Держи фотографию в кадре — история продолжается.';
  $('scan-frame').classList.add('found');
  $('replay').hidden = false;
  arVideo.pause();
  arVideo.src = scene.video;
  arVideo.loop = true;
  arVideo.muted = true;
  arVideo.load();
  arVideo.play().catch(() => {
    if (activeTarget === index) {
      $('camera-hint').textContent = 'Нажми «Ещё раз», чтобы запустить анимацию.';
    }
  });
}

function lost(index) {
  if (activeTarget !== index) return;
  activeTarget = null;
  arVideo.pause();
  if (meshes[index]) {
    meshes[index].material.map = textures[index];
    meshes[index].material.needsUpdate = true;
  }
  status.textContent = 'Найди свою вселенную';
  $('camera-hint').textContent = 'Наведи камеру на другую фотографию или верни эту в кадр.';
  $('scan-frame').classList.remove('found');
  $('replay').hidden = true;
}

arVideo.addEventListener('loadeddata', () => {
  if (activeTarget === null || !running) return;
  meshes[activeTarget].material.map = videoTexture;
  meshes[activeTarget].material.needsUpdate = true;
});

function haltCamera(ar) {
  if (!ar) return;
  ar.renderer.setAnimationLoop(null);
  ar.controller?.stopProcessVideo();
  ar.controller?.dispose();
  ar.controller?.worker?.terminate();
  ar.video?.srcObject?.getTracks().forEach((track) => track.stop());
  ar.video?.remove();
  for (const anchor of ar.anchors) {
    anchor.visible = false;
    anchor.group.visible = false;
  }
}

async function startCamera() {
  if (!scenes.length || running) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice('Открой эту страницу в Safari или другом браузере по защищённой ссылке и разреши камеру.');
    return;
  }
  const token = ++session;
  running = true;
  home.inert = true;
  home.setAttribute('aria-hidden', 'true');
  cameraView.hidden = false;
  document.body.style.overflow = 'hidden';
  status.textContent = 'Готовим камеру…';
  $('camera-hint').textContent = 'Разреши доступ к камере. При первом запуске потребуется немного времени.';
  $('scan-progress').hidden = false;
  $('scan-frame').classList.remove('found');
  $('close-camera').focus();
  try {
    const ar = await initializeEngine();
    if (token !== session) return;
    await ar.start();
    if (token !== session) { haltCamera(ar); return; }
    $('scan-progress').hidden = true;
    status.textContent = 'Найди свою вселенную';
    $('camera-hint').textContent = 'Помести фотографию целиком в кадр. Держи телефон спокойно.';
    ar.renderer.setAnimationLoop(() => ar.renderer.render(ar.scene, ar.camera));
  } catch (error) {
    if (token !== session) return;
    console.error('AR start failed', error);
    stopCamera();
    notice('Не удалось запустить камеру. Разреши доступ к ней в настройках браузера. Анимации также можно открыть нажатием на фото.');
  }
}

function stopCamera() {
  ++session;
  running = false;
  activeTarget = null;
  arVideo.pause();
  arVideo.removeAttribute('src');
  arVideo.load();
  haltCamera(engine);
  cameraView.hidden = true;
  $('replay').hidden = true;
  home.inert = false;
  home.removeAttribute('aria-hidden');
  document.body.style.overflow = '';
  startButton.focus();
}

startButton.addEventListener('click', startCamera);
$('close-camera').addEventListener('click', stopCamera);
$('camera-help').addEventListener('click', () => notice('Наводи камеру на сам рисунок, без сильного наклона. Помогают ровное освещение и матовая печать без бликов.'));
$('replay').addEventListener('click', () => {
  if (activeTarget !== null) {
    arVideo.currentTime = 0;
    arVideo.play().catch(() => notice('Попробуй вернуть фотографию в кадр.'));
  }
});
$('open-film').addEventListener('click', () => openVideo());
$('close-dialog').addEventListener('click', closeVideo);
dialog.addEventListener('cancel', closeVideo);
dialog.addEventListener('click', (event) => { if (event.target === dialog) closeVideo(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !cameraView.hidden) stopCamera(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    player.pause();
    if (running) stopCamera();
  }
});
window.addEventListener('pagehide', () => { player.pause(); if (running) stopCamera(); });
await loadScenes();
