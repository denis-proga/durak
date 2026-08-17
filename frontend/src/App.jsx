import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as THREE from 'three';
import { useGameSocket } from './useGameSocket';

// ============ ТОКЕНЫ СТИЛЯ: «НОЧНОЙ КАБАК» ============
const C = {
  felt: '#0B3D2E',
  feltDark: '#062A1E',
  wood: '#2B1B12',
  woodLight: '#4A3220',
  gold: '#C9A227',
  goldLight: '#E6C766',
  parchment: '#F3E9D2',
  parchmentDark: '#E4D6B0',
  crimson: '#8C1F28',
  ink: '#1A1410',
  inkSoft: '#3A2C22',
};

// ============ ПРОЦЕДУРНАЯ ГЕНЕРАЦИЯ ПЕРСОНАЖЕЙ ============
// Никаких внешних .glb — вся геометрия строится кодом, поэтому вес загрузки нулевой.

// Лепим из сферы правдоподобную форму черепа: сужаем челюсть, слегка сплющиваем
// затылок, вытягиваем подбородок — иначе голова читается как просто шар.
function makeHeadGeometry(radius = 1) {
  const geo = new THREE.SphereGeometry(radius, 32, 32);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const ny = v.y / radius; // -1 (низ) .. 1 (верх)

    // сужение к подбородку
    if (ny < 0) {
      const taper = 1 - Math.pow(-ny, 1.7) * 0.42;
      v.x *= taper;
      v.z *= taper;
    }
    // череп чуть уже висков вверху
    if (ny > 0.45) {
      const t = (ny - 0.45) / 0.55;
      v.x *= 1 - t * 0.12;
    }
    // лицо площе, затылок круглее
    if (v.z > 0) v.z *= 0.94;
    else v.z *= 1.06;
    // подбородок вперёд
    if (ny < -0.45 && v.z > 0) v.z += (-ny - 0.45) * radius * 0.36;
    // голова вытянута по вертикали
    v.y *= 1.14;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function skinMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.0,
  });
}

// Глаз: белок + радужка + зрачок + блик, посаженные в глазницу
function buildEye(side, ch, headR) {
  const g = new THREE.Group();
  const eyeR = headR * 0.115;

  const sclera = new THREE.Mesh(
    new THREE.SphereGeometry(eyeR, 18, 18),
    new THREE.MeshStandardMaterial({ color: '#F6F3EE', roughness: 0.28 })
  );
  g.add(sclera);

  const iris = new THREE.Mesh(
    new THREE.CircleGeometry(eyeR * 0.55, 20),
    new THREE.MeshStandardMaterial({ color: ch.eye || '#4A3423', roughness: 0.25 })
  );
  iris.position.z = eyeR * 0.9;
  g.add(iris);

  const pupil = new THREE.Mesh(
    new THREE.CircleGeometry(eyeR * 0.26, 16),
    new THREE.MeshBasicMaterial({ color: '#0B0907' })
  );
  pupil.position.z = eyeR * 0.93;
  g.add(pupil);

  const glint = new THREE.Mesh(
    new THREE.CircleGeometry(eyeR * 0.1, 10),
    new THREE.MeshBasicMaterial({ color: '#FFFFFF' })
  );
  glint.position.set(eyeR * 0.18, eyeR * 0.2, eyeR * 0.96);
  g.add(glint);

  // верхнее веко — прикрывает глаз сверху, даёт живой взгляд
  const lid = new THREE.Mesh(
    new THREE.SphereGeometry(eyeR * 1.06, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.42),
    skinMaterial(ch.skin)
  );
  lid.rotation.x = -0.32;
  g.add(lid);

  g.position.set(side * headR * 0.36, headR * 0.06, headR * 0.80);
  g.rotation.y = side * 0.16;
  return g;
}

function buildFace(ch, headR) {
  const g = new THREE.Group();

  g.add(buildEye(-1, ch, headR));
  g.add(buildEye(1, ch, headR));

  // брови — крупнее и темнее, они сильнее всего задают выражение
  [-1, 1].forEach((side) => {
    const brow = new THREE.Mesh(
      new THREE.BoxGeometry(headR * 0.36, headR * 0.085, headR * 0.09),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(ch.hair).multiplyScalar(0.85),
        roughness: 0.9,
      })
    );
    brow.position.set(side * headR * 0.38, headR * 0.3, headR * 0.83);
    brow.rotation.z = side * -0.16;
    brow.rotation.x = -0.24;
    g.add(brow);
  });

  // нос — спинка + кончик + крылья
  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(headR * 0.13, headR * 0.46, headR * 0.16),
    skinMaterial(ch.skin)
  );
  bridge.position.set(0, headR * 0.02, headR * 0.88);
  bridge.rotation.x = 0.14;
  g.add(bridge);

  const tip = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.115, 14, 14), skinMaterial(ch.skin));
  tip.position.set(0, headR * -0.2, headR * 0.98);
  g.add(tip);

  [-1, 1].forEach((side) => {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.072, 12, 12), skinMaterial(ch.skin));
    wing.position.set(side * headR * 0.12, headR * -0.22, headR * 0.92);
    g.add(wing);
  });

  // тень под носом даёт объём даже при плоском свете
  const nostrilMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(ch.skin).multiplyScalar(0.55),
    roughness: 0.9,
  });
  [-1, 1].forEach((side) => {
    const nostril = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.032, 10, 10), nostrilMat);
    nostril.position.set(side * headR * 0.07, headR * -0.26, headR * 0.94);
    g.add(nostril);
  });

  // губы — заметно контрастнее кожи, иначе рот не читается
  const lipColor = new THREE.Color(ch.skin).lerp(new THREE.Color('#8E3A3E'), 0.72);
  const lipMat = new THREE.MeshStandardMaterial({ color: lipColor, roughness: 0.4 });

  const upperLip = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.17, 18, 12), lipMat);
  upperLip.scale.set(1.3, 0.34, 0.5);
  upperLip.position.set(0, headR * -0.42, headR * 0.83);
  g.add(upperLip);

  const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.165, 18, 12), lipMat);
  lowerLip.scale.set(1.2, 0.44, 0.55);
  lowerLip.position.set(0, headR * -0.52, headR * 0.82);
  g.add(lowerLip);

  // линия рта между губами
  const mouthLine = new THREE.Mesh(
    new THREE.BoxGeometry(headR * 0.36, headR * 0.018, headR * 0.04),
    new THREE.MeshStandardMaterial({ color: lipColor.clone().multiplyScalar(0.45), roughness: 0.8 })
  );
  mouthLine.position.set(0, headR * -0.47, headR * 0.87);
  g.add(mouthLine);

  // уши
  [-1, 1].forEach((side) => {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.17, 14, 14), skinMaterial(ch.skin));
    ear.scale.set(0.3, 1.0, 0.65);
    ear.position.set(side * headR * 0.94, headR * -0.03, headR * 0.02);
    g.add(ear);
  });

  return g;
}

// Шапка волос с настоящей линией роста: спереди приподнята выше бровей,
// сзади опускается на затылок. Без этого волосы просто накрывают лицо.
function makeHairCapGeometry(radius) {
  const geo = new THREE.SphereGeometry(radius, 28, 24, 0, Math.PI * 2, 0, Math.PI * 0.66);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const front = v.z / radius; // >0 — лицевая сторона
    if (front > 0) {
      // чем ближе к лицу, тем выше поднимаем край волос
      v.y += front * radius * 0.62;
    }
    v.y *= 1.1;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function buildHair(ch, headR) {
  const g = new THREE.Group();
  const hairMat = new THREE.MeshStandardMaterial({ color: ch.hair, roughness: 0.9, metalness: 0.02 });
  const style = ch.hairStyle;

  if (style === 'afro') {
    // афро — объёмная масса, сдвинутая назад, чтобы не лезть на лицо
    const afro = new THREE.Mesh(new THREE.SphereGeometry(headR * 1.28, 22, 22), hairMat);
    afro.position.set(0, headR * 0.3, headR * -0.22);
    afro.scale.set(1, 0.95, 1);
    g.add(afro);
    const front = new THREE.Mesh(
      new THREE.SphereGeometry(headR * 1.06, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.34),
      hairMat
    );
    front.position.set(0, headR * 0.16, headR * 0.06);
    g.add(front);
    return g;
  }

  const cap = new THREE.Mesh(makeHairCapGeometry(headR * 1.05), hairMat);
  cap.position.y = headR * -0.05;
  g.add(cap);

  if (style === 'long') {
    const backVolume = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.92, 18, 18), hairMat);
    backVolume.scale.set(1, 1.05, 0.72);
    backVolume.position.set(0, headR * -0.2, headR * -0.42);
    g.add(backVolume);
    const fall = new THREE.Mesh(
      new THREE.CylinderGeometry(headR * 0.8, headR * 0.66, headR * 1.8, 20, 1, true),
      hairMat
    );
    fall.position.set(0, headR * -1.0, headR * -0.2);
    g.add(fall);
    // пряди по бокам лица
    [-1, 1].forEach((side) => {
      const strand = new THREE.Mesh(
        new THREE.CylinderGeometry(headR * 0.16, headR * 0.12, headR * 1.15, 10),
        hairMat
      );
      strand.position.set(side * headR * 0.82, headR * -0.6, headR * 0.18);
      g.add(strand);
    });
  } else if (style === 'braid') {
    const backVolume = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.88, 18, 18), hairMat);
    backVolume.scale.set(1, 1, 0.74);
    backVolume.position.set(0, headR * -0.15, headR * -0.4);
    g.add(backVolume);
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(new THREE.SphereGeometry(headR * (0.25 - i * 0.026), 12, 12), hairMat);
      seg.position.set(0, headR * (-0.7 - i * 0.34), headR * (-0.48 + i * 0.02));
      g.add(seg);
    }
  } else if (style === 'bun') {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.4, 16, 16), hairMat);
    bun.position.set(0, headR * 0.5, headR * -0.8);
    g.add(bun);
    const backVolume = new THREE.Mesh(new THREE.SphereGeometry(headR * 0.76, 16, 16), hairMat);
    backVolume.scale.set(1, 0.85, 0.7);
    backVolume.position.set(0, headR * -0.08, headR * -0.4);
    g.add(backVolume);
  }
  // 'short' — только шапка

  return g;
}

// Торс строим через LatheGeometry — профиль даёт плечи, талию и посадку одежды
function buildTorso(ch) {
  const isMale = ch.gender === 'm';
  const profile = isMale
    ? [
        [0.10, 1.14], [0.20, 1.10], [0.33, 1.00], [0.38, 0.86],
        [0.36, 0.60], [0.33, 0.32], [0.34, 0.06], [0.0, 0.0],
      ]
    : [
        [0.09, 1.14], [0.17, 1.10], [0.28, 1.00], [0.31, 0.86],
        [0.29, 0.62], [0.25, 0.38], [0.31, 0.08], [0.0, 0.0],
      ];
  const points = profile.map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(points, 28);
  return new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color: ch.shirt, roughness: 0.72 })
  );
}

// Руки, поднятые к груди и держащие веер карт
function buildArms(ch) {
  const g = new THREE.Group();
  const isMale = ch.gender === 'm';
  const sleeveMat = new THREE.MeshStandardMaterial({ color: ch.shirt, roughness: 0.72 });
  const handMat = skinMaterial(ch.skin);
  const upperR = isMale ? 0.082 : 0.068;

  [-1, 1].forEach((side) => {
    const shoulderX = side * (isMale ? 0.32 : 0.27);

    // плечо — идёт вниз и слегка вперёд
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(upperR, upperR * 0.88, 0.36, 12), sleeveMat);
    upper.position.set(shoulderX, 0.9, 0.04);
    upper.rotation.z = side * 0.2;
    upper.rotation.x = -0.15;
    g.add(upper);

    const elbow = new THREE.Mesh(new THREE.SphereGeometry(upperR * 0.94, 12, 12), sleeveMat);
    elbow.position.set(shoulderX + side * 0.055, 0.72, 0.09);
    g.add(elbow);

    // предплечье — поднято вперёд-вверх к центру груди, к картам
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(upperR * 0.8, upperR * 0.66, 0.38, 12), sleeveMat);
    fore.position.set(shoulderX + side * 0.005, 0.79, 0.28);
    fore.rotation.x = 1.15;
    fore.rotation.z = side * 0.42;
    g.add(fore);

    // кисть — развёрнута ладонью к себе, держит карты
    const handX = shoulderX - side * 0.075;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(upperR * 0.9, 14, 14), handMat);
    hand.scale.set(0.55, 1.15, 0.85);
    hand.position.set(handX, 0.88, 0.44);
    hand.rotation.z = side * 0.3;
    g.add(hand);

    // большой палец поверх карт
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(upperR * 0.3, 10, 10), handMat);
    thumb.scale.set(0.8, 1.6, 0.8);
    thumb.position.set(handX - side * 0.028, 0.93, 0.5);
    thumb.rotation.z = side * 0.7;
    g.add(thumb);

    // пальцы, обхватывающие веер снизу
    for (let f = 0; f < 3; f++) {
      const finger = new THREE.Mesh(new THREE.SphereGeometry(upperR * 0.26, 8, 8), handMat);
      finger.scale.set(0.75, 1.5, 0.75);
      finger.position.set(handX + side * 0.012, 0.84 - f * 0.038, 0.47);
      finger.rotation.z = side * 0.25;
      g.add(finger);
    }
  });

  return g;
}

// Собираем персонажа целиком
function buildCharacterAvatar(ch) {
  const group = new THREE.Group();
  const headR = 0.2;

  group.add(buildTorso(ch));
  group.add(buildArms(ch));

  // воротник
  const collar = new THREE.Mesh(
    new THREE.TorusGeometry(ch.gender === 'm' ? 0.115 : 0.1, 0.028, 10, 22),
    new THREE.MeshStandardMaterial({ color: ch.accent, roughness: 0.6 })
  );
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 1.13;
  group.add(collar);

  // шея
  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(headR * 0.42, headR * 0.5, 0.17, 16),
    skinMaterial(ch.skin)
  );
  neck.position.y = 1.19;
  group.add(neck);

  // голова + лицо + причёска
  const headGroup = new THREE.Group();
  const head = new THREE.Mesh(makeHeadGeometry(headR), skinMaterial(ch.skin));
  headGroup.add(head);
  headGroup.add(buildFace(ch, headR));
  headGroup.add(buildHair(ch, headR));
  headGroup.position.y = 1.46;
  group.add(headGroup);

  return group;
}

// Отслеживаем размер экрана — интерфейс заметно отличается на телефоне и десктопе
function useViewport() {
  const [vp, setVp] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1024,
    h: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  const isMobile = vp.w < 700;
  const isShort = vp.h < 520; // телефон в горизонтальной ориентации
  return { ...vp, isMobile, isShort };
}

// На телефоне нужно запретить «резиновую» прокрутку и зум двумя пальцами,
// иначе жест броска карты будет конфликтовать с прокруткой страницы.
function useMobileViewportFix() {
  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    const prevContent = meta.content;
    meta.content =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

    const prevOverflow = document.body.style.overflow;
    const prevOverscroll = document.body.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.body.style.margin = '0';

    return () => {
      meta.content = prevContent;
      document.body.style.overflow = prevOverflow;
      document.body.style.overscrollBehavior = prevOverscroll;
    };
  }, []);
}

function useGoogleFonts() {
  useEffect(() => {
    if (document.getElementById('durak-fonts')) return;
    const link = document.createElement('link');
    link.id = 'durak-fonts';
    link.rel = 'stylesheet';
    link.href =
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap';
    document.head.appendChild(link);
  }, []);
}

const CHARACTERS = [
  {
    id: 'amir',
    name: 'Амир',
    origin: 'Нигерия',
    gender: 'm',
    eye: '#3A2415',
    skin: '#5A3620',
    hair: '#171008',
    hairStyle: 'afro',
    shirt: '#1F7A5C',
    accent: '#E8B33D',
  },
  {
    id: 'mei',
    name: 'Мэй',
    origin: 'Китай',
    gender: 'f',
    eye: '#2E1F14',
    skin: '#E8C49A',
    hair: '#12100E',
    hairStyle: 'long',
    shirt: '#8C1F3D',
    accent: '#E9DCC3',
  },
  {
    id: 'oksana',
    name: 'Оксана',
    origin: 'Украина',
    gender: 'f',
    eye: '#4F7A8C',
    skin: '#EBC6A4',
    hair: '#C9A227',
    hairStyle: 'braid',
    shirt: '#F2EBDD',
    accent: '#C4342F',
  },
  {
    id: 'jack',
    name: 'Джек',
    origin: 'США',
    gender: 'm',
    eye: '#3E6B4A',
    skin: '#D9A87C',
    hair: '#6B4423',
    hairStyle: 'short',
    shirt: '#2C4A7A',
    accent: '#D6D3CB',
  },
  {
    id: 'lukas',
    name: 'Лукас',
    origin: 'Германия',
    gender: 'm',
    eye: '#5B87A8',
    skin: '#EBCDAE',
    hair: '#D6C08A',
    hairStyle: 'short',
    shirt: '#3D4A52',
    accent: '#9BA6AD',
  },
  {
    id: 'lucia',
    name: 'Лусия',
    origin: 'Испания',
    gender: 'f',
    eye: '#3B2517',
    skin: '#C99B6E',
    hair: '#2B1B12',
    hairStyle: 'bun',
    shirt: '#B8342B',
    accent: '#E8B33D',
  },
];


function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ============ ГЛАВНЫЙ КОМПОНЕНТ ============
export default function DurakApp() {
  useGoogleFonts();
  useMobileViewportFix();
  const [screen, setScreen] = useState('login');
  const [nickname, setNickname] = useState('');
  const [mode, setMode] = useState('create'); // 'create' | 'join'
  const [playerCount, setPlayerCount] = useState(4);
  const [translatable, setTranslatable] = useState(true);
  const [pairDefense, setPairDefense] = useState(false);
  const [createdCode, setCreatedCode] = useState(generateRoomCode());
  const [joinCode, setJoinCode] = useState('');
  const [characterId, setCharacterId] = useState(CHARACTERS[0].id);

  const activeCode = (mode === 'create' ? createdCode : joinCode).toUpperCase();

  const { state, status, error, actions } = useGameSocket({
    code: activeCode,
    name: nickname,
    charId: characterId,
    maxPlayers: playerCount,
    translatable,
    pairDefense,
    enabled: screen !== 'login',
  });

  if (screen === 'login') {
    return (
      <LoginScreen
        nickname={nickname}
        setNickname={setNickname}
        mode={mode}
        setMode={setMode}
        playerCount={playerCount}
        setPlayerCount={setPlayerCount}
        translatable={translatable}
        setTranslatable={setTranslatable}
        pairDefense={pairDefense}
        setPairDefense={setPairDefense}
        createdCode={createdCode}
        onRegenerateCode={() => setCreatedCode(generateRoomCode())}
        joinCode={joinCode}
        setJoinCode={setJoinCode}
        characterId={characterId}
        setCharacterId={setCharacterId}
        onEnter={() => setScreen('room')}
      />
    );
  }

  // ждём первый пакет состояния от сервера
  if (!state) {
    return (
      <ConnectingScreen
        status={status}
        error={error}
        code={activeCode}
        onBack={() => setScreen('login')}
      />
    );
  }

  if (state.in_lobby) {
    return (
      <LobbyScreen
        state={state}
        myName={nickname}
        error={error}
        onStart={actions.start}
        onBack={() => setScreen('login')}
      />
    );
  }

  return (
    <TableScreen
      state={state}
      actions={actions}
      error={error}
      connectionStatus={status}
      onExit={() => setScreen('login')}
    />
  );
}

// ============ ЭКРАН ПОДКЛЮЧЕНИЯ ============
function ConnectingScreen({ status, error, code, onBack }) {
  const fatal = error?.message && status !== 'open';
  return (
    <CenteredCard>
      <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 26, margin: 0, color: C.ink }}>
        Комната {code}
      </h2>
      <p style={{ color: C.inkSoft, fontSize: 13, marginTop: 8 }}>
        {status === 'connecting' && 'Подключаемся к серверу…'}
        {status === 'open' && 'Соединение установлено, ждём данные…'}
        {status === 'closed' && 'Связь потеряна, пробуем переподключиться…'}
        {status === 'error' && 'Не удалось подключиться к серверу'}
      </p>
      {fatal && (
        <p style={{ color: C.crimson, fontSize: 12, marginTop: 10 }}>{error.message}</p>
      )}
      {(status === 'error' || status === 'closed') && (
        <p style={{ color: C.inkSoft, fontSize: 11, marginTop: 12 }}>
          Проверь, что сервер запущен: <code>python manage.py runserver 0.0.0.0:8000</code>
        </p>
      )}
      <button onClick={onBack} style={{ ...primaryButton, marginTop: 18 }}>
        Назад
      </button>
    </CenteredCard>
  );
}

// ============ ЛОББИ ============
function LobbyScreen({ state, myName, error, onStart, onBack }) {
  const { lobby } = state;
  const isHost = lobby.host.trim().toLowerCase() === myName.trim().toLowerCase();

  const copyCode = () => {
    navigator.clipboard?.writeText(lobby.code);
  };

  return (
    <CenteredCard>
      <div style={{ textAlign: 'center' }}>
        <p style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: C.inkSoft, margin: 0 }}>
          Код комнаты
        </p>
        <div
          onClick={copyCode}
          style={{
            fontFamily: "'Cormorant Garamond', serif",
            fontSize: 42,
            fontWeight: 700,
            letterSpacing: 8,
            color: C.ink,
            cursor: 'pointer',
            margin: '2px 0 4px',
          }}
        >
          {lobby.code}
        </div>
        <p style={{ fontSize: 11, color: C.inkSoft, margin: 0 }}>нажми, чтобы скопировать</p>
      </div>

      <div style={{ margin: '20px 0 8px', fontSize: 12, fontWeight: 600, color: C.inkSoft }}>
        Игроки ({lobby.seats.length}/{lobby.max_players})
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {lobby.seats.map((s) => {
          const ch = CHARACTERS.find((c) => c.id === s.char_id) || CHARACTERS[0];
          return (
            <div
              key={s.pid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 10,
                background: '#FBF6E9',
                border: `1.5px solid ${s.connected ? C.gold : '#C0392B'}`,
                opacity: s.connected ? 1 : 0.6,
              }}
            >
              <AvatarPortrait char={ch} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.ink }}>
                  {s.name}
                  {s.name === lobby.host && (
                    <span style={{ fontSize: 10, color: C.inkSoft, marginLeft: 6 }}>· создатель</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: s.connected ? C.inkSoft : '#C0392B' }}>
                  {s.connected ? ch.name : 'нет связи'}
                </div>
              </div>
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, lobby.max_players - lobby.seats.length) }).map((_, i) => (
          <div
            key={`empty${i}`}
            style={{
              padding: '14px 12px',
              borderRadius: 10,
              border: `1.5px dashed rgba(26,20,16,0.25)`,
              fontSize: 12,
              color: C.inkSoft,
              textAlign: 'center',
            }}
          >
            Ждём игрока…
          </div>
        ))}
      </div>

      {(lobby.games_played || 0) > 0 && (
        <div style={{ marginTop: 16 }}>
          <StandingsTable standings={lobby.standings || []} myPid={state.me} />
        </div>
      )}

      {error && (
        <p style={{ color: '#C0392B', fontSize: 12, marginTop: 12, textAlign: 'center' }}>
          {error.message}
        </p>
      )}

      {isHost ? (
        <button
          onClick={onStart}
          disabled={!lobby.can_start}
          style={{
            ...primaryButton,
            marginTop: 18,
            opacity: lobby.can_start ? 1 : 0.5,
            cursor: lobby.can_start ? 'pointer' : 'not-allowed',
          }}
        >
          {lobby.can_start ? 'Начать партию' : 'Нужно минимум 2 игрока'}
        </button>
      ) : (
        <p style={{ textAlign: 'center', color: C.inkSoft, fontSize: 12, marginTop: 18 }}>
          Ждём, пока {lobby.host} начнёт партию…
        </p>
      )}

      <button
        onClick={onBack}
        style={{ ...primaryButton, marginTop: 8, background: 'transparent', color: C.inkSoft, boxShadow: 'none' }}
      >
        Выйти
      </button>
    </CenteredCard>
  );
}

// Таблица званий: у кого сколько погонов заработано за сессию
function StandingsTable({ standings, myPid }) {
  if (!standings.length) return null;
  return (
    <div style={{ margin: '4px 0 0' }}>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: 1,
          color: C.inkSoft,
          marginBottom: 7,
        }}
      >
        Погоны сессии
      </div>
      <div style={{ fontSize: 9.5, color: C.inkSoft, marginBottom: 8, lineHeight: 1.4 }}>
        Слева — подцепленный погон. Лестница у каждого своя:
        6 → 7 → 8 → 9 → 10 → В → Д → К → Т → дама пик.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {standings.map((row) => {
          const isMe = row.pid === myPid;
          return (
            <div
              key={row.pid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 9,
                background: isMe ? 'rgba(201,162,39,0.2)' : 'rgba(26,20,16,0.06)',
                border: `1px solid ${isMe ? C.gold : 'rgba(26,20,16,0.12)'}`,
              }}
            >
              {/* сам погон — карта, которую «прицепили» */}
              <div
                style={{
                  width: 26,
                  height: 34,
                  borderRadius: 4,
                  flexShrink: 0,
                  background: row.card ? '#FFFFFF' : 'rgba(26,20,16,0.07)',
                  border: `1.5px solid ${row.card ? '#B01E2E' : 'rgba(26,20,16,0.2)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: "'Arial Black', Arial, sans-serif",
                  fontSize: row.card === '10' ? 11 : 14,
                  color: row.card ? '#B01E2E' : 'rgba(26,20,16,0.3)',
                }}
              >
                {row.card || '—'}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.ink }}>
                  {row.name}
                  {isMe && <span style={{ fontSize: 9, color: C.inkSoft }}> · ты</span>}
                </div>
                <div style={{ fontSize: 10.5, color: row.level ? '#8C1F28' : C.inkSoft }}>
                  {row.rank}
                  {row.next && (
                    <span style={{ color: C.inkSoft }}> · далее {row.next}</span>
                  )}
                </div>
              </div>

              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.ink, lineHeight: 1 }}>
                  {row.losses}
                </div>
                <div style={{ fontSize: 8.5, color: C.inkSoft }}>проигр.</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CenteredCard({ children }) {
  const { isMobile } = useViewport();
  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        background: `radial-gradient(ellipse at 50% 30%, ${C.woodLight} 0%, ${C.wood} 55%, ${C.ink} 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', sans-serif",
        padding: isMobile ? 12 : 24,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: `linear-gradient(180deg, ${C.parchment}, ${C.parchmentDark})`,
          borderRadius: 18,
          border: `2px solid ${C.gold}`,
          boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
          padding: isMobile ? '22px 18px' : '30px 26px',
          margin: 'auto',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const primaryButton = {
  width: '100%',
  padding: 13,
  borderRadius: 10,
  border: 'none',
  background: `linear-gradient(145deg, ${C.goldLight}, ${C.gold})`,
  color: C.ink,
  fontWeight: 700,
  fontSize: 15,
  fontFamily: "'Inter', sans-serif",
  cursor: 'pointer',
  boxShadow: '0 6px 16px rgba(201,162,39,0.45)',
};

// ============ ЭКРАН ВХОДА ============
function LoginScreen({
  nickname,
  setNickname,
  mode,
  setMode,
  playerCount,
  setPlayerCount,
  translatable,
  setTranslatable,
  pairDefense,
  setPairDefense,
  createdCode,
  onRegenerateCode,
  joinCode,
  setJoinCode,
  characterId,
  setCharacterId,
  onEnter,
}) {
  const { isMobile } = useViewport();
  const canSubmit = nickname.trim().length > 0 && (mode === 'create' || joinCode.trim().length > 0);
  const canPair = playerCount >= 4;

  return (
    <div
      style={{
        height: '100dvh',
        width: '100%',
        background: `radial-gradient(ellipse at 50% 30%, ${C.woodLight} 0%, ${C.wood} 55%, ${C.ink} 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: "'Inter', sans-serif",
        padding: isMobile ? '12px' : '24px',
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          background: `linear-gradient(180deg, ${C.parchment}, ${C.parchmentDark})`,
          borderRadius: 18,
          border: `2px solid ${C.gold}`,
          boxShadow: `0 20px 60px rgba(0,0,0,0.55), inset 0 0 40px rgba(201,162,39,0.15)`,
          padding: isMobile ? '20px 16px' : '32px 26px',
          margin: 'auto',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 22 }}>
          <div
            style={{
              width: 52,
              height: 52,
              margin: '0 auto 10px',
              borderRadius: '50%',
              background: `linear-gradient(145deg, ${C.goldLight}, ${C.gold})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              boxShadow: `0 4px 14px rgba(201,162,39,0.5)`,
            }}
          >
            ♠
          </div>
          <h1
            style={{
              fontFamily: "'Cormorant Garamond', serif",
              fontWeight: 700,
              fontSize: 30,
              color: C.ink,
              margin: 0,
              letterSpacing: 0.5,
            }}
          >
            Дурак
          </h1>
        </div>

        {/* Вкладки: создать / войти */}
        <div style={{ display: 'flex', borderRadius: 10, background: 'rgba(26,20,16,0.08)', padding: 4, marginBottom: 18 }}>
          {[
            { key: 'create', label: 'Создать комнату' },
            { key: 'join', label: 'Войти по коду' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setMode(t.key)}
              style={{
                flex: 1,
                padding: '9px 6px',
                borderRadius: 7,
                border: 'none',
                background: mode === t.key ? C.ink : 'transparent',
                color: mode === t.key ? C.parchment : C.inkSoft,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: "'Inter', sans-serif",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <Field label="Твой ник">
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Например, Денис"
            style={inputStyle}
          />
        </Field>

        <Field label="Твой персонаж за столом">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 7 }}>
            {CHARACTERS.map((ch) => {
              const active = ch.id === characterId;
              return (
                <button
                  key={ch.id}
                  onClick={() => setCharacterId(ch.id)}
                  style={{
                    padding: '9px 4px 7px',
                    borderRadius: 9,
                    border: `2px solid ${active ? C.gold : 'rgba(26,20,16,0.15)'}`,
                    background: active ? 'rgba(201,162,39,0.18)' : '#FBF6E9',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 4,
                    fontFamily: "'Inter', sans-serif",
                  }}
                >
                  <AvatarPortrait char={ch} />
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.ink }}>{ch.name}</span>
                  <span style={{ fontSize: 9, color: C.inkSoft }}>
                    {ch.gender === 'm' ? '♂' : '♀'} {ch.origin}
                  </span>
                </button>
              );
            })}
          </div>
        </Field>

        {mode === 'join' ? (
          <Field label="Код комнаты от того, кто её создал">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="ABCD12"
              style={inputStyle}
            />
          </Field>
        ) : (
          <>
            <Field label="Сколько игроков">
              <div style={{ display: 'flex', gap: 6 }}>
                {[2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    onClick={() => setPlayerCount(n)}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      borderRadius: 8,
                      border: `1.5px solid ${playerCount === n ? C.gold : 'rgba(26,20,16,0.2)'}`,
                      background: playerCount === n ? `linear-gradient(145deg, ${C.goldLight}, ${C.gold})` : '#FBF6E9',
                      color: C.ink,
                      fontWeight: 700,
                      fontSize: 14,
                      cursor: 'pointer',
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Правила отбоя">
              <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: `1.5px solid ${C.gold}` }}>
                {[
                  { v: true, label: 'Переводной' },
                  { v: false, label: 'Обычный' },
                ].map((opt) => (
                  <button
                    key={String(opt.v)}
                    onClick={() => setTranslatable(opt.v)}
                    style={{
                      flex: 1,
                      padding: '10px 0',
                      border: 'none',
                      background: translatable === opt.v ? C.gold : '#FBF6E9',
                      color: C.ink,
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <div
              onClick={() => canPair && setPairDefense((p) => !p)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '11px 14px',
                borderRadius: 8,
                background: '#FBF6E9',
                border: `1.5px solid ${C.gold}`,
                marginBottom: 14,
                opacity: canPair ? 1 : 0.45,
                cursor: canPair ? 'pointer' : 'not-allowed',
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.ink }}>Парная отбивка</div>
                <div style={{ fontSize: 11, color: C.inkSoft }}>
                  {canPair ? 'Доступно при 4–6 игроках' : 'Нужно минимум 4 игрока'}
                </div>
              </div>
              <div
                style={{
                  width: 38,
                  height: 22,
                  borderRadius: 999,
                  background: pairDefense && canPair ? C.gold : 'rgba(26,20,16,0.2)',
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    background: '#fff',
                    position: 'absolute',
                    top: 2,
                    left: pairDefense && canPair ? 18 : 2,
                    transition: 'left 0.15s',
                  }}
                />
              </div>
            </div>

            <Field label="Код комнаты — поделись с друзьями">
              <div style={{ display: 'flex', gap: 6 }}>
                <div
                  style={{
                    ...inputStyle,
                    flex: 1,
                    fontWeight: 700,
                    letterSpacing: 2,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  {createdCode}
                </div>
                <button
                  onClick={onRegenerateCode}
                  title="Сгенерировать новый код (новая комната)"
                  style={{
                    padding: '0 14px',
                    borderRadius: 8,
                    border: `1.5px solid ${C.gold}`,
                    background: '#FBF6E9',
                    color: C.ink,
                    fontSize: 16,
                    cursor: 'pointer',
                  }}
                >
                  🔄
                </button>
              </div>
            </Field>
          </>
        )}

        <button
          disabled={!canSubmit}
          onClick={onEnter}
          style={{
            width: '100%',
            marginTop: 6,
            padding: '14px',
            borderRadius: 10,
            border: 'none',
            background: canSubmit
              ? `linear-gradient(145deg, ${C.goldLight}, ${C.gold})`
              : '#B9AE93',
            color: C.ink,
            fontWeight: 700,
            fontSize: 15,
            fontFamily: "'Inter', sans-serif",
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            boxShadow: canSubmit ? '0 6px 16px rgba(201,162,39,0.45)' : 'none',
            transition: 'transform 0.15s',
          }}
          onPointerDown={(e) => canSubmit && (e.currentTarget.style.transform = 'scale(0.97)')}
          onPointerUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}
        >
          {mode === 'join' ? 'Войти в комнату' : 'Создать комнату'}
        </button>

        <p style={{ textAlign: 'center', color: C.inkSoft, fontSize: 11, marginTop: 14 }}>
          Прототип визуала · подключение к серверу будет отдельно
        </p>
      </div>
    </div>
  );
}

// ---- Мини-портрет персонажа для экрана выбора ----
function AvatarPortrait({ char }) {
  const { skin, hair, hairStyle, shirt, accent } = char;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44">
      <circle cx="22" cy="22" r="21" fill={shirt} />
      {/* плечи */}
      <path d="M8 44 Q8 32 22 32 Q36 32 36 44 Z" fill={accent} />
      {/* волосы — задний объём */}
      {hairStyle === 'afro' && <circle cx="22" cy="17" r="13" fill={hair} />}
      {hairStyle === 'long' && <path d="M9 18 Q9 6 22 6 Q35 6 35 18 L35 34 L30 34 L30 18 L14 18 L14 34 L9 34 Z" fill={hair} />}
      {hairStyle === 'braid' && <path d="M10 18 Q10 6 22 6 Q34 6 34 18 L34 26 L30 26 L30 17 L14 17 L14 26 L10 26 Z" fill={hair} />}
      {hairStyle === 'bun' && <circle cx="22" cy="7" r="6" fill={hair} />}
      {/* лицо */}
      <circle cx="22" cy="19" r="9.5" fill={skin} />
      {/* волосы — чёлка/верх */}
      {hairStyle === 'short' && <path d="M12.5 17 Q13 9 22 9 Q31 9 31.5 17 Q27 13 22 13 Q17 13 12.5 17 Z" fill={hair} />}
      {hairStyle === 'bun' && <path d="M12.5 17 Q13 9 22 9 Q31 9 31.5 17 Q27 12 22 12 Q17 12 12.5 17 Z" fill={hair} />}
      {hairStyle === 'long' && <path d="M12.5 16 Q13 8 22 8 Q31 8 31.5 16 Q26 11 22 11 Q17 11 12.5 16 Z" fill={hair} />}
      {hairStyle === 'braid' && <path d="M12.5 16 Q13 8 22 8 Q31 8 31.5 16 Q26 11 22 11 Q17 11 12.5 16 Z" fill={hair} />}
      {hairStyle === 'afro' && <circle cx="22" cy="12.5" r="10" fill={hair} />}
      {hairStyle === 'afro' && <circle cx="22" cy="20" r="8.5" fill={skin} />}
      {/* глаза */}
      <circle cx="18.5" cy="19.5" r="1.2" fill="#221A12" />
      <circle cx="25.5" cy="19.5" r="1.2" fill="#221A12" />
    </svg>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.8,
          color: C.inkSoft,
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 8,
  border: `1.5px solid ${C.gold}`,
  background: '#FBF6E9',
  color: C.ink,
  fontSize: 15,
  fontFamily: "'Inter', sans-serif",
  outline: 'none',
  boxSizing: 'border-box',
};


// ============ ЭКРАН СТОЛА (3D) ============
function TableScreen({ state, actions, error, connectionStatus, onExit }) {
  const { isMobile, isShort } = useViewport();
  const mountRef = useRef(null);
  const sceneApiRef = useRef({});
  const gyroState = useRef({ supported: false, calibrated: false, gamma0: 0, beta0: 0, dYaw: 0, dPitch: 0, targetYaw: 0, targetPitch: 0 });
  const dragState = useRef({ dragging: false, lastX: 0, lastY: 0, isThrow: false });
  const throwStart = useRef({ x: 0, y: 0 });

  const game = state.game;
  const myPid = state.me;
  const roomCode = state.lobby.code;
  const rules = game.rules;

  // ---- Разворачиваем серверное состояние в удобный вид ----
  // Места поворачиваем так, чтобы ТЫ всегда сидел на позиции 0 (лицом к столу),
  // а остальные располагались вокруг в правильном порядке хода.
  const myServerIndex = Math.max(0, game.players.findIndex((p) => p.pid === myPid));
  const players = game.players.map((_, i) => {
    const src = game.players[(myServerIndex + i) % game.players.length];
    const char = CHARACTERS.find((c) => c.id === src.char_id) || CHARACTERS[i % CHARACTERS.length];
    return {
      id: src.pid,
      pid: src.pid,
      name: src.name,
      isYou: src.pid === myPid,
      cardCount: src.card_count,
      connected: src.connected,
      isOut: src.is_out,
      team: src.team,
      char,
    };
  });

  const hand = (game.my_hand || []).map((c, i) => ({
    ...c,
    id: `${c.rank}${c.suit}`,
    idx: i,
    red: c.suit === '♥' || c.suit === '♦',
  }));
  const handRef = useRef([]);

  const legalKeys = new Set((game.my_legal_cards || []).map((c) => `${c.rank}${c.suit}`));
  const iAmDefender = game.defender === myPid;
  const iAmAttacker = game.attacker === myPid;
  const defenderName = game.players.find((p) => p.pid === game.defender)?.name || '';
  const attackerName = game.players.find((p) => p.pid === game.attacker)?.name || '';
  const readySet = new Set(
    (game.passed || []).map((pid) => game.players.find((p) => p.pid === pid)?.name).filter(Boolean)
  );
  const iAmReady = (game.passed || []).includes(myPid);
  const paused = game.paused;
  const finished = game.phase === 'finished';
  // Игрок сбросил все карты и вышел из партии — он больше не участвует
  // в текущей раздаче, только наблюдает за оставшимися.
  const iAmOut = game.players.find((p) => p.pid === myPid)?.is_out === true;

  const cardRefs = useRef([]);
  const [selectedIndex, setSelectedIndex] = useState(null);

  // Сцена должна пересобираться ТОЛЬКО когда реально меняется состав стола,
  // а не на каждое обновление состояния — иначе карты со стола стираются.
  const seatSignature = players.map((p) => `${p.pid}:${p.char.id}`).join('|');
  const playersRef = useRef(players);
  playersRef.current = players;
  const [sceneVersion, setSceneVersion] = useState(0);
  const selectedRef = useRef(null);
  useEffect(() => {
    selectedRef.current = selectedIndex;
  }, [selectedIndex]);

  const [hoverIndex, setHoverIndex] = useState(null);
  const hoverIndexRef = useRef(null);
  // какую карту на столе игрок сейчас целится побить
  const targetSlotRef = useRef(null);
  const defenderRef = useRef(false);

  const turnRef = useRef(() => {});

  const [standing, setStanding] = useState(false);
  const standingRef = useRef(false);
  useEffect(() => {
    standingRef.current = standing;
  }, [standing]);

  const [shownTrumpCard, setShownTrumpCard] = useState(null);
  const [beatBanner, setBeatBanner] = useState(false);
  const prevTableLen = useRef(0);
  const prevDeck = useRef(game.deck_count);
  const prevTook = useRef(false);
  const prevDefender = useRef(game.defender);
  const prevDefenderName = useRef('');
  const [tookBanner, setTookBanner] = useState(null);

  // Тикаем раз в секунду, пока кто-то отключён — иначе таймер ожидания замрёт
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!state.lobby?.waiting) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [state.lobby?.waiting]);

  // ---- Синхронизация 3D-сцены с состоянием сервера ----
  const prevGameId = useRef(null);
  useEffect(() => {
    const api = sceneApiRef.current;
    if (!api.syncTable) return;

    // Новая партия (в том числе «Ещё партию») — старый стол нужно снести
    // полностью, иначе карты прошлой раздачи копятся горой на новой.
    if (game.game_id && prevGameId.current !== null && prevGameId.current !== game.game_id) {
      api.resetTable?.();
    }
    prevGameId.current = game.game_id ?? prevGameId.current;

    // настоящий козырь и реальный остаток колоды
    if (game.trump_card) {
      api.setTrump?.(game.trump_card.rank, game.trump_card.suit);
    }
    api.setDeckCount?.(game.deck_count);

    // позиция того, кто ходит (для анимации вылета карты)
    const attackerLocalIdx = players.findIndex((p) => p.pid === game.attacker);
    const fromPos = api.seatPosition?.(attackerLocalIdx >= 0 ? attackerLocalIdx : 0);

    // зона считается относительно НАШЕЙ раскладки мест
    const gapLocal =
      (game.gap_index - myServerIndex + game.players.length) % game.players.length;

    // реальное место защищающегося — сервер уже пропускает вышедших игроков
    // при выборе следующего, поэтому это может быть НЕ соседнее место
    const defenderLocalIdx = players.findIndex((p) => p.pid === game.defender);

    // Кто забрал карты — берём ИЗ СОБЫТИЯ сервера, а не из defender_took:
    // сервер выполняет взятие и закрытие захода одним сообщением, поэтому
    // флаг defender_took до клиента в положении true просто не доезжает.
    const ev = state.last_event;
    const tookNow = ev?.kind === 'bout_over' && ev.took === true;
    const takerLocalIdx = tookNow ? players.findIndex((p) => p.pid === ev.taker) : -1;
    const takerPos = takerLocalIdx >= 0 ? api.seatPosition?.(takerLocalIdx) : null;

    api.syncTable(game.table, gapLocal, fromPos, takerPos, defenderLocalIdx >= 0 ? defenderLocalIdx : null);

    // стол опустел — показываем «БИТО» только если карты действительно отбили
    if (prevTableLen.current > 0 && game.table.length === 0) {
      if (tookNow) {
        setTookBanner(ev.taker_name || '');
        setTimeout(() => setTookBanner(null), 1300);
      } else {
        setBeatBanner(true);
        setTimeout(() => setBeatBanner(false), 1100);
      }
    }
    prevTableLen.current = game.table.length;
    prevTook.current = game.defender_took;
    prevDefender.current = game.defender;
    prevDefenderName.current =
      game.players.find((p) => p.pid === game.defender)?.name || '';

    // колода уменьшилась — показываем подбор карт
    if (game.deck_count < prevDeck.current) {
      const drawn = prevDeck.current - game.deck_count;
      const perSeat = players.map((p, i) => ({
        seatIndex: i,
        count: Math.max(1, Math.round(drawn / players.length)),
      }));
      api.dealCards?.(perSeat);
    }
    prevDeck.current = game.deck_count;
  }, [game.table, game.gap_index, game.deck_count, game.attacker, myServerIndex, sceneVersion, state.last_event]);

  // показ козыря другим игроком
  const trumpBannerTimeoutRef = useRef(null);
  useEffect(() => {
    const ev = state.last_event;
    if (ev?.kind === 'show_trump' && ev.card) {
      setShownTrumpCard({
        ...ev.card,
        by: ev.by,
        red: ev.card.suit === '♥' || ev.card.suit === '♦',
      });
      // Раньше здесь была очистка через return () => clearTimeout(t) — но эффект
      // перезапускается на КАЖДОЕ новое сообщение сервера, и если событие
      // приходило раньше, чем истекали 2.4с, таймер отменялся, а баннер
      // так и оставался висеть до конца игры. Теперь таймер не зависит
      // от последующих обновлений и всегда успевает сработать.
      clearTimeout(trumpBannerTimeoutRef.current);
      trumpBannerTimeoutRef.current = setTimeout(() => setShownTrumpCard(null), 2400);
    } else if (ev?.kind === 'bout_over' || ev?.kind === 'game_over' || ev?.kind === 'start' || ev?.kind === 'restart') {
      clearTimeout(trumpBannerTimeoutRef.current);
      setShownTrumpCard(null);
    }
  }, [state.last_event]);

  // На случай смены партии/выхода из комнаты баннер не должен пережить размонтирование
  useEffect(() => () => clearTimeout(trumpBannerTimeoutRef.current), []);

  const toggleReady = useCallback(() => {
    if (iAmReady) actions.unready();
    else actions.ready();
  }, [iAmReady, actions]);

  const handleTranslate = useCallback(() => {
    const idx = selectedRef.current;
    const card = idx !== null ? handRef.current[idx] : null;
    if (!card) return;
    actions.translate({ rank: card.rank, suit: card.suit });
    setSelectedIndex(null);
  }, [actions]);

  const handleShowTrump = useCallback(() => {
    const idx = selectedRef.current;
    const card = idx !== null ? handRef.current[idx] : null;
    if (!card) return;
    actions.showTrump({ rank: card.rank, suit: card.suit });
    setSelectedIndex(null);
  }, [actions]);

  const handleTake = useCallback(() => actions.take(), [actions]);

  const toggleStand = useCallback(() => {
    setStanding((prev) => {
      const next = !prev;
      sceneApiRef.current.setStanding?.(next);
      return next;
    });
  }, []);

  // Сыграть карту: если ты защищаешься — бьём первый неотбитый слот,
  // иначе это атака/подкидывание. Правомерность проверит сервер.
  defenderRef.current = iAmDefender;

  const playCardRef = useRef(() => {});
  playCardRef.current = (card, targetSlot) => {
    const payload = { rank: card.rank, suit: card.suit };
    if (iAmDefender) {
      // если игрок дотянул карту до конкретной — бьём именно её
      const slot =
        targetSlot !== null && targetSlot !== undefined
          ? targetSlot
          : game.table.findIndex((s) => !s.defense);
      actions.defend(payload, slot < 0 ? 0 : slot);
    } else {
      actions.attack(payload);
    }
  };

  // Свой порядок карт в руке. Храним ИМЕНА карт, а не индексы:
  // индексы сбивались при каждом обновлении с сервера, из-за чего
  // визуальный порядок расходился с реальными картами.
  const [cardOrder, setCardOrder] = useState([]);

  const orderedHand = (() => {
    const byKey = new Map(hand.map((card) => [card.id, card]));
    const result = [];
    // сначала карты в сохранённом игроком порядке
    cardOrder.forEach((key) => {
      const card = byKey.get(key);
      if (card) {
        result.push(card);
        byKey.delete(key);
      }
    });
    // затем всё, что пришло нового (добор) — в конец
    byKey.forEach((card) => result.push(card));
    return result;
  })();

  // ВАЖНО: жесты работают с индексами ОТОБРАЖАЕМОЙ руки,
  // поэтому ref должен указывать именно на неё, а не на порядок сервера.
  handRef.current = orderedHand;

  const orderRef = useRef(() => {});
  orderRef.current = (from, to) => {
    const keys = orderedHand.map((c) => c.id);
    if (from < 0 || to < 0 || from >= keys.length || to >= keys.length) return;
    [keys[from], keys[to]] = [keys[to], keys[from]];
    setCardOrder(keys);
  };

  const onCardPointerDown = useCallback((index, e) => {
    if (standingRef.current) return; // играть можно только сидя
    setSelectedIndex((prev) => (prev === index ? null : index));
    selectedRef.current = index;
    dragState.current.dragging = true;
    dragState.current.isThrow = true;
    throwStart.current = { x: e.clientX, y: e.clientY };
  }, []);

  // ---- Гироскоп ОТКЛЮЧЁН намеренно ----
  // На Android датчики ориентации часто дают дёрганые/неоткалиброванные
  // значения (в отличие от iOS, где либо разрешение не выдано и включался
  // тот же плавный свайв пальцем, либо сенсор стабильнее). Чтобы поведение
  // было ОДИНАКОВЫМ на всех телефонах и совпадало с управлением мышью на
  // ноуте, камера теперь поворачивается ТОЛЬКО пальцем/мышью — везде один
  // и тот же код (onPointerMove ниже), без зависимости от кривых сенсоров.
  const handleOrientation = useCallback(() => {}, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.ink);
    scene.fog = new THREE.Fog(C.ink, 5, 18);

    const camera = new THREE.PerspectiveCamera(58, mount.clientWidth / mount.clientHeight, 0.1, 50);
    camera.rotation.order = 'YXZ';

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    // ---- Свет: тёплое яркое пятно над столом, вокруг мягкая темнота ----
    const ambient = new THREE.AmbientLight(0x554431, 2.3);
    scene.add(ambient);

    const hemi = new THREE.HemisphereLight(0xffdca8, 0x0a1a12, 1.4);
    scene.add(hemi);

    const lamp = new THREE.PointLight(0xffd08a, 6.5, 20, 1.1);
    lamp.position.set(0, 3.4, 0);
    scene.add(lamp);
    buildLampFixture(scene, lamp.position);

    // прожектор широким конусом на весь стол, включая края и игроков вокруг
    const tableSpot = new THREE.SpotLight(0xfff0d6, 8, 15, Math.PI / 2.6, 0.75, 1.1);
    tableSpot.position.set(0, 3.35, 0);
    tableSpot.target.position.set(0, 0.2, 0);
    scene.add(tableSpot);
    scene.add(tableSpot.target);

    const rim = new THREE.PointLight(0xc9a227, 1.2, 16, 1.4);
    rim.position.set(-4, 2, -4);
    scene.add(rim);

    const rim2 = new THREE.PointLight(0xc9a227, 1.0, 16, 1.4);
    rim2.position.set(4, 2, 4);
    scene.add(rim2);

    const barLight = new THREE.PointLight(0xffb35c, 1.6, 8, 2);
    barLight.position.set(-6.2, 2.4, -1);
    scene.add(barLight);

    // ---- Комната: пол, стены, картины, барная стойка ----
    buildRoom(scene);
    buildBar(scene);

    // ---- Стол ----
    const woodMat = new THREE.MeshStandardMaterial({ color: C.wood, roughness: 0.7, metalness: 0.1 });
    const table = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.4, 0.3, 48), woodMat);
    table.position.y = 0;
    scene.add(table);

    const feltMat = new THREE.MeshStandardMaterial({ color: C.felt, roughness: 0.95 });
    const felt = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.06, 48), feltMat);
    felt.position.y = 0.18;
    scene.add(felt);

    const rimGold = new THREE.Mesh(
      new THREE.TorusGeometry(3.02, 0.04, 12, 48),
      new THREE.MeshStandardMaterial({ color: C.gold, metalness: 0.6, roughness: 0.3 })
    );
    rimGold.rotation.x = Math.PI / 2;
    rimGold.position.y = 0.19;
    scene.add(rimGold);

    // ---- Зоны розыгрыша: промежутки МЕЖДУ соседними игроками ----
    // Зона i лежит между игроком i и игроком i+1. Атака i→i+1 и все подкидывания идут в зону i.
    const PLAYER_COUNT = playersRef.current.length;
    const R_GAP = 1.95; // радиус, на котором лежат карты — ближе к краю, чем центр стола
    const GAP_ZONES = Array.from({ length: PLAYER_COUNT }, (_, i) => {
      const gapAngle = -((i + 0.5) / PLAYER_COUNT) * Math.PI * 2;
      const cx = Math.sin(gapAngle) * R_GAP;
      const cz = Math.cos(gapAngle) * R_GAP;
      // 6 слотов внутри зоны: 3 в ряд × 2 ряда, развёрнутые по касательной к столу
      const slots = [];
      const tangentX = Math.cos(gapAngle);
      const tangentZ = -Math.sin(gapAngle);
      const radialX = Math.sin(gapAngle);
      const radialZ = Math.cos(gapAngle);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const t = (col - 1) * 0.58;
          const r = (row === 0 ? 0.38 : -0.38);
          slots.push(
            new THREE.Vector3(cx + tangentX * t + radialX * r, 0.26, cz + tangentZ * t + radialZ * r)
          );
        }
      }
      return { index: i, angle: gapAngle, center: new THREE.Vector3(cx, 0.26, cz), slots, cards: [] };
    });

    // ---- Динамическая зона: строится под РЕАЛЬНУЮ пару атакующий-защищающийся ----
    // Раньше зона бралась из фиксированного массива по месту атакующего, и если
    // сосед справа от него вышел из игры, зона всё равно рисовалась у ЕГО места,
    // а не там, где реально сидит защищающийся. Теперь угол зоны — это середина
    // дуги между двумя РЕАЛЬНЫМИ участниками розыгрыша, кто бы ни выбыл между ними.
    const zoneCache = new Map();
    const seatAngleOf = (seatIdx) => -(seatIdx / PLAYER_COUNT) * Math.PI * 2;

    function buildZoneAt(gapAngle) {
      const cx = Math.sin(gapAngle) * R_GAP;
      const cz = Math.cos(gapAngle) * R_GAP;
      const slots = [];
      const tangentX = Math.cos(gapAngle);
      const tangentZ = -Math.sin(gapAngle);
      const radialX = Math.sin(gapAngle);
      const radialZ = Math.cos(gapAngle);
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const t = (col - 1) * 0.58;
          const r = row === 0 ? 0.38 : -0.38;
          slots.push(new THREE.Vector3(cx + tangentX * t + radialX * r, 0.26, cz + tangentZ * t + radialZ * r));
        }
      }
      return { angle: gapAngle, center: new THREE.Vector3(cx, 0.26, cz), slots, cards: [] };
    }

    function getDynamicZone(attackerSeat, defenderSeat) {
      const key = `${attackerSeat}:${defenderSeat}`;
      if (zoneCache.has(key)) return zoneCache.get(key);
      const a1 = seatAngleOf(attackerSeat);
      const a2 = seatAngleOf(defenderSeat);
      let diff = a2 - a1;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const zone = buildZoneAt(a1 + diff / 2);
      zoneCache.set(key, zone);
      return zone;
    }

    // пунктирная разметка слотов
    const zoneOutlines = [];
    GAP_ZONES.forEach((zone) => {
      const groupLines = [];
      zone.slots.forEach((slot) => {
        const hw = 0.27, hh = 0.37;
        const ca = Math.cos(-zone.angle), sa = Math.sin(-zone.angle);
        const corner = (dx, dz) =>
          new THREE.Vector3(slot.x + dx * ca - dz * sa, 0.192, slot.z + dx * sa + dz * ca);
        const pts = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh), corner(-hw, -hh)];
        const geo = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineDashedMaterial({
          color: C.gold,
          dashSize: 0.05,
          gapSize: 0.04,
          transparent: true,
          opacity: 0.35,
        });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        scene.add(line);
        groupLines.push(line);
      });
      zoneOutlines.push(groupLines);
    });

    // ---- Колода в центре + козырная карта ----
    // И размер колоды, и козырь берутся из состояния сервера — раньше здесь
    // был захардкоженный туз бубей, из-за чего масть козыря всегда врала.
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    const backTexture = makeCardBackTexture();
    backTexture.anisotropy = maxAniso;
    const backMat = new THREE.MeshBasicMaterial({ map: backTexture });

    const deckMeshes = [];
    const MAX_DECK_VISUAL = 16;
    for (let i = 0; i < MAX_DECK_VISUAL; i++) {
      const c = new THREE.Mesh(new THREE.PlaneGeometry(0.50, 0.69), backMat);
      c.rotation.x = -Math.PI / 2;
      c.rotation.z = (Math.random() - 0.5) * 0.1;
      c.position.set(-0.5, 0.221 + i * 0.006, 0);
      c.visible = false;
      scene.add(c);
      deckMeshes.push(c);
    }

    const trump = new THREE.Mesh(
      new THREE.PlaneGeometry(0.50, 0.69),
      new THREE.MeshBasicMaterial({ map: backTexture })
    );
    trump.rotation.x = -Math.PI / 2;
    trump.rotation.z = Math.PI / 2 + 0.5;
    trump.position.set(0.05, 0.235, 0);
    trump.visible = false;
    scene.add(trump);

    let trumpKey = null;
    sceneApiRef.current.setTrump = (rank, suit) => {
      const key = `${rank}${suit}`;
      if (key === trumpKey) return;
      trumpKey = key;
      const tex = makeCardFaceTexture(rank, suit);
      tex.anisotropy = maxAniso;
      trump.material.map = tex;
      trump.material.needsUpdate = true;
      trump.visible = true;
    };

    // высота стопки отражает реальное число оставшихся карт
    sceneApiRef.current.setDeckCount = (count) => {
      const shown = Math.min(MAX_DECK_VISUAL, Math.max(0, count - 1)); // -1: козырь лежит отдельно
      deckMeshes.forEach((m, i) => {
        m.visible = i < shown;
      });
      // когда колода пуста, козырь уже забран игроком
      trump.visible = count > 0 && trumpKey !== null;
    };

    // ---- Игроки за столом ----
    const R_SEAT = 3.35;
    const total = playersRef.current.length;
    const seatMeshes = [];
    const opponentSeats = [];
    let mySeatPos = new THREE.Vector3(0, 1.55, R_SEAT);
    let myHandPos = new THREE.Vector3(0, 0.3, R_SEAT * 0.9);

    playersRef.current.forEach((p, i) => {
      // минус — чтобы очередь шла ПО ЧАСОВОЙ стрелке (следующий игрок слева от тебя)
      const angle = -(i / total) * Math.PI * 2;
      const x = Math.sin(angle) * R_SEAT;
      const z = Math.cos(angle) * R_SEAT;

      if (p.isYou) {
        mySeatPos = new THREE.Vector3(x * 0.97, 1.55, z * 0.97);
        myHandPos = new THREE.Vector3(x * 0.9, 0.3, z * 0.9);
        return; // свою фигурку не рисуем — это точка обзора камеры
      }

      const ch = p.char || CHARACTERS[i % CHARACTERS.length];
      const group = buildCharacterAvatar(ch);

      // веер карт — зажат между кистями рук
      for (let k = -2; k <= 2; k++) {
        const back = new THREE.Mesh(
          new THREE.PlaneGeometry(0.19, 0.27),
          new THREE.MeshBasicMaterial({ map: backTexture, side: THREE.DoubleSide })
        );
        back.position.set(k * 0.045, 0.92 + Math.abs(k) * -0.008, 0.46 + Math.abs(k) * 0.004);
        back.rotation.x = -0.28;
        back.rotation.z = k * 0.13;
        group.add(back);
      }

      group.position.set(x, 0, z);
      group.lookAt(0, 0.9, 0);

      const label = makeTextSprite(`${p.name} · ${ch.name}`);
      label.position.set(0, 1.95, 0);
      group.add(label);

      scene.add(group);
      seatMeshes.push(group);
      opponentSeats.push({ id: p.id, name: p.name, pos: new THREE.Vector3(x, 0.26, z) });
    });

    camera.position.copy(mySeatPos);
    camera.lookAt(0, 0.4, 0);
    const baseYaw = camera.rotation.y;
    const basePitch = camera.rotation.x;
    const towardCenter = new THREE.Vector3(-mySeatPos.x, 0, -mySeatPos.z).normalize();
    const standState = { current: 0, target: 0 };
    sceneApiRef.current.setStanding = (v) => {
      standState.target = v ? 1 : 0;
    };

    // ---- Бросок карты в зону-промежуток между атакующим и защищающимся ----
    const flyingCards = [];
    const cardFaceCache = {};
    const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const SUITS = ['♠', '♥', '♦', '♣'];
    const getFaceTexture = (rank, suit) => {
      const key = rank + suit;
      if (!cardFaceCache[key]) cardFaceCache[key] = makeCardFaceTexture(rank, suit);
      return cardFaceCache[key];
    };
    const randomFaceTexture = () =>
      getFaceTexture(RANKS[Math.floor(Math.random() * RANKS.length)], SUITS[Math.floor(Math.random() * SUITS.length)]);

    // индекс места игрока (0 = ты, дальше по часовой стрелке)
    const seatIndexOf = (name) => players.findIndex((p) => p.name === name || (p.isYou && name === 'Ты'));

    // атака игрока i на игрока i+1 идёт в зону i
    const gapIndexFor = (attackerSeat) => ((attackerSeat % PLAYER_COUNT) + PLAYER_COUNT) % PLAYER_COUNT;

    let activeGapIndex = null; // где сейчас лежит текущая атака

    const throwCardToGap = (startPos, gapIndex, faceTexture, turnTargetName) => {
      const zone = GAP_ZONES[gapIndex];
      if (!zone || zone.cards.length >= 6) return;
      const tex = faceTexture || randomFaceTexture();
      tex.anisotropy = maxAniso;
      const slot = zone.slots[zone.cards.length];
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.50, 0.69),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.rotation.z = -zone.angle;
      mesh.position.copy(startPos);
      scene.add(mesh);
      zone.cards.push(mesh);
      activeGapIndex = gapIndex;
      flyingCards.push({
        mesh,
        start: startPos.clone(),
        end: slot.clone(),
        endRotZ: -zone.angle,
        t0: performance.now(),
        duration: 620,
        spin: (Math.random() - 0.5) * 6,
        onLand: () => turnTargetName && turnRef.current && turnRef.current(turnTargetName),
      });
    };

    // ПЕРЕВОД: вся пачка выложенных карт уезжает в следующую зону-промежуток
    const translateAttack = () => {
      if (activeGapIndex === null) return;
      const from = GAP_ZONES[activeGapIndex];
      const toIndex = (activeGapIndex + 1) % PLAYER_COUNT;
      const to = GAP_ZONES[toIndex];
      const moving = from.cards.splice(0, from.cards.length);
      moving.forEach((mesh, i) => {
        const slot = to.slots[i];
        if (!slot) return;
        to.cards.push(mesh);
        flyingCards.push({
          mesh,
          start: mesh.position.clone(),
          end: slot.clone(),
          startRotZ: mesh.rotation.z,
          endRotZ: -to.angle,
          t0: performance.now() + i * 55, // лёгкий каскад, чтобы пачка ехала волной
          duration: 520,
          slide: true, // едет по столу, а не летит по дуге
        });
      });
      activeGapIndex = toIndex;
      const nextDefender = players[(toIndex + 1) % PLAYER_COUNT];
      if (nextDefender && turnRef.current) turnRef.current(nextDefender.name);
    };

    // определяем, на какого игрока указывает жест свайпа — по его текущей проекции на экран
    const resolveTargetIndexByScreenDir = (dx, dy) => {
      const swipeAngle = Math.atan2(-dy, dx);
      const originX = mount.clientWidth / 2;
      const originY = mount.clientHeight * 0.92;
      let best = 0;
      let bestDiff = Infinity;
      opponentSeats.forEach((s, i) => {
        const p = s.pos.clone();
        p.y += 0.3;
        p.project(camera);
        const sx = (p.x * 0.5 + 0.5) * mount.clientWidth;
        const sy = (1 - (p.y * 0.5 + 0.5)) * mount.clientHeight;
        const ang = Math.atan2(-(sy - originY), sx - originX);
        let diff = Math.abs(ang - swipeAngle);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      });
      return best;
    };

    sceneApiRef.current.throwCardByGesture = (cardData, dx, dy) => {
      const oppIdx = resolveTargetIndexByScreenDir(dx, dy);
      const targetName = opponentSeats[oppIdx]?.name || '';
      const defenderSeat = seatIndexOf(targetName);
      // ты — место 0; атакуешь того, кто в зоне между вами
      const gapIndex = activeGapIndex !== null ? activeGapIndex : gapIndexFor(defenderSeat - 1);
      throwCardToGap(myHandPos, gapIndex, getFaceTexture(cardData.rank, cardData.suit), targetName);
    };

    // тестовый ход одного соперника на другого
    sceneApiRef.current.simulateOpponentMove = (fromName, toName) => {
      const from = opponentSeats.find((s) => s.name === fromName);
      const fromSeat = seatIndexOf(fromName);
      if (!from) return;
      throwCardToGap(from.pos, gapIndexFor(fromSeat), randomFaceTexture(), toName);
    };

    sceneApiRef.current.translateAttack = translateAttack;
    sceneApiRef.current.hasActiveAttack = () => activeGapIndex !== null;
    sceneApiRef.current.opponentNames = opponentSeats.map((s) => s.name);

    // ---- ОТБОЙ: все карты со стола уезжают в сброс ----
    const DISCARD_POS = new THREE.Vector3(-1.35, 0.24, 1.15);
    let discardCount = 0;

    sceneApiRef.current.sweepToDiscard = () => {
      const zones = activeGapIndex !== null ? [GAP_ZONES[activeGapIndex]] : GAP_ZONES;
      let moved = 0;
      zones.forEach((zone) => {
        const cards = zone.cards.splice(0, zone.cards.length);
        cards.forEach((mesh, i) => {
          discardCount += 1;
          const target = DISCARD_POS.clone();
          target.y += discardCount * 0.004;
          target.x += (Math.random() - 0.5) * 0.05;
          target.z += (Math.random() - 0.5) * 0.05;
          flyingCards.push({
            mesh,
            start: mesh.position.clone(),
            end: target,
            startRotZ: mesh.rotation.z,
            endRotZ: Math.random() * Math.PI * 2,
            t0: performance.now() + i * 45,
            duration: 480,
            slide: true,
            flipToBack: true, // в сбросе карты лежат рубашкой вверх
          });
          moved += 1;
        });
      });
      activeGapIndex = null;
      return moved;
    };

    // ---- ПОДБОР: карты летят из колоды в руки игроков ----
    const DECK_POS = new THREE.Vector3(-0.5, 0.3, 0);

    // ---- СИНХРОНИЗАЦИЯ СО СТЕЙТОМ СЕРВЕРА ----
    // Сервер — единственный источник правды. Здесь мы лишь приводим
    // 3D-картинку в соответствие с тем, что он прислал.
    const shownCards = new Map(); // ключ "slot:role" -> mesh

    const cardKey = (slotIdx, role) => `${slotIdx}:${role}`;

    // Новая партия — старые ключи слотов ("0:a", "1:a"...) снова используются
    // с нуля, поэтому синхронизация по ключам считает их "уже показанными"
    // и старые карты с прошлой партии просто оставались висеть на столе,
    // накапливаясь горой. Явно чистим сцену при смене game_id.
    sceneApiRef.current.resetTable = () => {
      for (const mesh of shownCards.values()) {
        scene.remove(mesh);
        if (mesh.geometry) mesh.geometry.dispose();
      }
      shownCards.clear();
      // и все карты, ещё летящие в анимации — они из прошлой партии
      flyingCards.length = 0;
      activeGapIndex = null;
    };

    // takenBy: позиция игрока, забравшего карты. Если задана — карты летят
    // ему в руки, а не в отбой. Иначе это обычное «бито».
    // defenderIdx: место РЕАЛЬНОГО защищающегося (может быть не соседним,
    // если между ним и атакующим кто-то вышел из игры).
    sceneApiRef.current.syncTable = (tableState, gapIdx, seatOfPid, takenBy, defenderIdx) => {
      const zone = getDynamicZone(gapIdx, defenderIdx != null ? defenderIdx : (gapIdx + 1) % PLAYER_COUNT);
      if (!zone) return;
      activeGapIndex = gapIdx;

      // Смещение карты защиты считаем В СИСТЕМЕ КООРДИНАТ ЗОНЫ, а не мира —
      // иначе при другом угле зоны карта уезжала куда попало вместо того,
      // чтобы лечь поверх побитой.
      const ca = Math.cos(-zone.angle);
      const sa = Math.sin(-zone.angle);
      const localOffset = (base, dx, dz, dy) => {
        const p = base.clone();
        p.x += dx * ca - dz * sa;
        p.z += dx * sa + dz * ca;
        p.y += dy;
        return p;
      };

      const slotFor = (i) => (zone.slots[i] ? zone.slots[i].clone() : zone.center.clone());
      const wanted = new Set();

      tableState.forEach((slot, i) => {
        const base = slotFor(i);

        // --- атакующая карта ---
        const aKey = cardKey(i, 'a');
        wanted.add(aKey);
        let aMesh = shownCards.get(aKey);
        if (!aMesh) {
          const tex = getFaceTexture(slot.attack.rank, slot.attack.suit);
          tex.anisotropy = maxAniso;
          aMesh = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.69),
            new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
          );
          aMesh.rotation.x = -Math.PI / 2;
          const from = seatOfPid ? seatOfPid.clone() : zone.center.clone();
          from.y = 0.5;
          aMesh.position.copy(from);
          scene.add(aMesh);
          shownCards.set(aKey, aMesh);
          flyingCards.push({
            mesh: aMesh,
            start: from,
            end: base,
            endRotZ: -zone.angle,
            t0: performance.now(),
            duration: 520,
            spin: (Math.random() - 0.5) * 5,
          });
        } else if (aMesh.position.distanceTo(base) > 0.02) {
          // зона сменилась (например, после перевода) — подтягиваем карту на место
          flyingCards.push({
            mesh: aMesh,
            start: aMesh.position.clone(),
            end: base,
            startRotZ: aMesh.rotation.z,
            endRotZ: -zone.angle,
            t0: performance.now(),
            duration: 420,
            slide: true,
          });
        }

        // --- карта защиты: ложится ПОВЕРХ побитой, с лёгким сдвигом ---
        if (slot.defense) {
          const dKey = cardKey(i, 'd');
          wanted.add(dKey);

          // Гарантируем, что побитая карта УЖЕ на своём месте: иначе защита
          // прилетит в расчётную точку, а атака останется в стороне —
          // именно так карта и «улетала мимо» после перевода.
          if (aMesh && aMesh.position.distanceTo(base) > 0.02) {
            for (let k = flyingCards.length - 1; k >= 0; k--) {
              if (flyingCards[k].mesh === aMesh) flyingCards.splice(k, 1);
            }
            aMesh.position.copy(base);
            aMesh.rotation.x = -Math.PI / 2;
            aMesh.rotation.z = -zone.angle;
          }

          const target = localOffset(base, 0.11, 0.13, 0.014);
          let dMesh = shownCards.get(dKey);
          if (!dMesh) {
            const tex = getFaceTexture(slot.defense.rank, slot.defense.suit);
            tex.anisotropy = maxAniso;
            dMesh = new THREE.Mesh(
              new THREE.PlaneGeometry(0.5, 0.69),
              new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide })
            );
            dMesh.rotation.x = -Math.PI / 2;
            const from = base.clone();
            from.y = 0.62;
            dMesh.position.copy(from);
            scene.add(dMesh);
            shownCards.set(dKey, dMesh);
            flyingCards.push({
              mesh: dMesh,
              start: from,
              end: target,
              endRotZ: -zone.angle + 0.2,
              t0: performance.now(),
              duration: 380,
              spin: 1.2,
            });
          } else if (dMesh.position.distanceTo(target) > 0.02) {
            flyingCards.push({
              mesh: dMesh,
              start: dMesh.position.clone(),
              end: target,
              startRotZ: dMesh.rotation.z,
              endRotZ: -zone.angle + 0.2,
              t0: performance.now(),
              duration: 420,
              slide: true,
            });
          }
        }
      });

      // всё, чего больше нет в стейте, — либо в отбой, либо в руки взявшему
      const leaving = Array.from(shownCards.entries()).filter(([k]) => !wanted.has(k));
      leaving.forEach(([key, mesh], i) => {
        shownCards.delete(key);
        if (takenBy) {
          const target = takenBy.clone();
          target.y += 0.4;
          flyingCards.push({
            mesh,
            start: mesh.position.clone(),
            end: target,
            startRotZ: mesh.rotation.z,
            endRotZ: mesh.rotation.z,
            t0: performance.now() + i * 60,
            duration: 520,
            spin: (Math.random() - 0.5) * 4,
            fadeOut: true,
          });
        } else {
          discardCount += 1;
          const target = DISCARD_POS.clone();
          target.y += discardCount * 0.004;
          target.x += (Math.random() - 0.5) * 0.06;
          target.z += (Math.random() - 0.5) * 0.06;
          flyingCards.push({
            mesh,
            start: mesh.position.clone(),
            end: target,
            startRotZ: mesh.rotation.z,
            endRotZ: Math.random() * Math.PI * 2,
            t0: performance.now() + i * 40,
            duration: 460,
            slide: true,
            flipToBack: true,
          });
        }
      });

      if (tableState.length === 0) activeGapIndex = null;
    };

    // ---- Какую карту на столе игрок сейчас «целит» пальцем ----
    // Проецируем неотбитые карты на экран и ищем ближайшую к пальцу.
    // Благодаря этому можно бить карты в любом порядке, а не только слева направо.
    // ВАЖНО: порога расстояния больше нет — раньше, если палец оказывался
    // дальше 150px от любой карты, подсветка молча не срабатывала, и игра
    // тихо била "первый неотбитый слот по порядку" — это и было причиной
    // жалобы "бьётся не та карта, требует определённый порядок".
    sceneApiRef.current.slotUnderPointer = (screenX, screenY) => {
      let best = null;
      let bestDist = Infinity;
      for (const [key, mesh] of shownCards.entries()) {
        if (!key.endsWith(':a')) continue; // только атакующие карты
        const slotIdx = Number(key.split(':')[0]);
        if (shownCards.has(`${slotIdx}:d`)) continue; // уже отбита
        const p = mesh.position.clone();
        p.y += 0.05;
        p.project(camera);
        const sx = (p.x * 0.5 + 0.5) * mount.clientWidth;
        const sy = (1 - (p.y * 0.5 + 0.5)) * mount.clientHeight;
        const d = Math.hypot(sx - screenX, sy - screenY);
        if (d < bestDist) {
          bestDist = d;
          best = { slotIndex: slotIdx, screenX: sx, screenY: sy, dist: d };
        }
      }
      // Всегда возвращаем ближайшую карту, если хоть одна есть на столе —
      // а не только если попал точно рядом.
      return best;
    };

    // подсветка выбранной для отбоя карты
    let highlightRing = null;
    sceneApiRef.current.highlightSlot = (slotIndex) => {
      if (highlightRing) {
        scene.remove(highlightRing);
        highlightRing.geometry.dispose();
        highlightRing.material.dispose();
        highlightRing = null;
      }
      if (slotIndex === null || slotIndex === undefined) return;
      const mesh = shownCards.get(`${slotIndex}:a`);
      if (!mesh) return;
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, 0.81),
        new THREE.MeshBasicMaterial({
          color: 0x7FE3A1,
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
        })
      );
      ring.rotation.copy(mesh.rotation);
      ring.position.copy(mesh.position);
      ring.position.y -= 0.004;
      scene.add(ring);
      highlightRing = ring;
    };

    sceneApiRef.current.seatPosition = (seatIndex) => {
      if (seatIndex === 0) return myHandPos.clone();
      const s = opponentSeats[seatIndex - 1];
      return s ? s.pos.clone() : null;
    };

    sceneApiRef.current.dealCards = (perSeat) => {
      // perSeat: [{ seatIndex, count }] — сколько карт добирает каждое место
      let delay = 0;
      perSeat.forEach(({ seatIndex, count }) => {
        const isMe = seatIndex === 0;
        const seat = isMe ? { pos: myHandPos } : opponentSeats[seatIndex - 1];
        if (!seat) return;
        for (let c = 0; c < count; c++) {
          const mesh = new THREE.Mesh(
            new THREE.PlaneGeometry(0.5, 0.69),
            new THREE.MeshBasicMaterial({ map: backTexture, side: THREE.DoubleSide })
          );
          mesh.rotation.x = -Math.PI / 2;
          mesh.position.copy(DECK_POS);
          scene.add(mesh);
          const end = seat.pos.clone();
          end.y += 0.35;
          flyingCards.push({
            mesh,
            start: DECK_POS.clone(),
            end,
            endRotZ: (Math.random() - 0.5) * 0.6,
            t0: performance.now() + delay,
            duration: 420,
            spin: (Math.random() - 0.5) * 5,
            fadeOut: true, // растворяется, «попав в руку»
          });
          delay += 90;
        }
      });
      return delay;
    };

    // ---- Управление мышью/пальцем (десктоп-фолбэк и доп. контроль камерой) ----
    const onPointerDown = (e) => {
      if (dragState.current.isThrow) return; // жест уже начат нажатием на карту в руке
      dragState.current.dragging = true;
      dragState.current.lastX = e.clientX;
      dragState.current.lastY = e.clientY;
    };
    const onPointerMove = (e) => {
      if (dragState.current.isThrow) {
        const inHandZone = e.clientY > mount.clientHeight - 150;

        // Тянем карту над столом — подсвечиваем ту, которую собираемся бить
        if (!inHandZone && defenderRef.current) {
          const target = sceneApiRef.current.slotUnderPointer?.(e.clientX, e.clientY);
          const slot = target ? target.slotIndex : null;
          if (targetSlotRef.current !== slot) {
            targetSlotRef.current = slot;
            sceneApiRef.current.highlightSlot?.(slot);
          }
        } else if (targetSlotRef.current !== null) {
          targetSlotRef.current = null;
          sceneApiRef.current.highlightSlot?.(null);
        }

        let nearest = null;
        if (inHandZone) {
          let bestDist = Infinity;
          cardRefs.current.forEach((el, i) => {
            if (!el || i === selectedRef.current) return;
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const d = Math.abs(cx - e.clientX);
            if (d < bestDist) {
              bestDist = d;
              nearest = i;
            }
          });
        }
        if (hoverIndexRef.current !== nearest) {
          hoverIndexRef.current = nearest;
          setHoverIndex(nearest);
        }
        return;
      }
      if (!dragState.current.dragging) return;
      const dx = e.clientX - dragState.current.lastX;
      const dy = e.clientY - dragState.current.lastY;
      dragState.current.lastX = e.clientX;
      dragState.current.lastY = e.clientY;
      const g = gyroState.current;
      g.targetYaw = THREE.MathUtils.clamp(g.targetYaw - dx * 0.005, -1.1, 1.1);
      g.targetPitch = THREE.MathUtils.clamp(g.targetPitch - dy * 0.005, -0.85, 0.6);
    };
    const onPointerUp = (e) => {
      if (dragState.current.isThrow) {
        const dx = e.clientX - throwStart.current.x;
        const dy = e.clientY - throwStart.current.y;
        const dist = Math.hypot(dx, dy);
        const idx = selectedRef.current;
        const releasedInHandZone = e.clientY > mount.clientHeight - 150;

        let keepSelection = false;

        if (idx !== null && handRef.current[idx]) {
          const card = handRef.current[idx];
          if (!releasedInHandZone && dist > 45) {
            // Свайп на стол. Если тянули на конкретную карту — бьём именно её,
            // иначе сервер сам выберет первый неотбитый слот.
            playCardRef.current(card, targetSlotRef.current);
          } else if (releasedInHandZone && dist > 12) {
            // перестановка карт в руке — чисто локальный визуальный порядок
            const nearest = hoverIndexRef.current;
            if (nearest !== null && nearest !== idx) {
              orderRef.current(idx, nearest);
            }
          } else {
            // Просто тап без движения — карта остаётся ВЫБРАННОЙ.
            // Иначе невозможно нажать «Перевести» или «Показать козырь»:
            // выбор сбрасывался в тот же момент, когда отпускаешь палец.
            keepSelection = true;
          }
        }

        if (!keepSelection) {
          setSelectedIndex(null);
          selectedRef.current = null;
        }
        hoverIndexRef.current = null;
        setHoverIndex(null);
        targetSlotRef.current = null;
        sceneApiRef.current.highlightSlot?.(null);
      }
      dragState.current.dragging = false;
      dragState.current.isThrow = false;
    };

    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // ---- Цикл рендера ----
    let raf;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      const g = gyroState.current;
      g.dYaw += (g.targetYaw - g.dYaw) * 0.08;
      g.dPitch += (g.targetPitch - g.dPitch) * 0.08;
      camera.rotation.y = baseYaw + g.dYaw;
      camera.rotation.x = basePitch + g.dPitch;

      standState.current += (standState.target - standState.current) * 0.08;
      camera.position.set(
        mySeatPos.x + towardCenter.x * standState.current * 0.7,
        mySeatPos.y + standState.current * 0.85,
        mySeatPos.z + towardCenter.z * standState.current * 0.7
      );
      lamp.intensity = 6.5 + Math.sin(Date.now() * 0.001) * 0.25;

      // ---- полёт брошенных карт ----
      const now = performance.now();
      for (let i = flyingCards.length - 1; i >= 0; i--) {
        const fc = flyingCards[i];
        if (now < fc.t0) continue; // каскадная задержка при переводе
        const t = Math.min(1, (now - fc.t0) / fc.duration);
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        fc.mesh.position.lerpVectors(fc.start, fc.end, ease);
        // перевод/сброс — карты скользят по столу; обычный бросок — летят по дуге
        fc.mesh.position.y += Math.sin(t * Math.PI) * (fc.slide ? 0.12 : 1.0);
        if (fc.slide) {
          const from = fc.startRotZ ?? fc.mesh.rotation.z;
          fc.mesh.rotation.z = from + (fc.endRotZ - from) * ease;
        } else {
          fc.mesh.rotation.z += 0.15 * fc.spin * (1 - t * 0.5);
        }
        // в сбросе карта переворачивается рубашкой вверх
        if (fc.flipToBack && !fc.flipped && t > 0.5) {
          fc.flipped = true;
          fc.mesh.material = backMat;
        }
        // подобранная карта растворяется, «попав в руку»
        if (fc.fadeOut && t > 0.65) {
          fc.mesh.material.transparent = true;
          fc.mesh.material.opacity = Math.max(0, 1 - (t - 0.65) / 0.35);
        }
        if (t >= 1) {
          if (fc.fadeOut) {
            scene.remove(fc.mesh);
            fc.mesh.geometry.dispose();
          } else {
            fc.mesh.rotation.x = -Math.PI / 2;
            fc.mesh.rotation.z = fc.endRotZ ?? fc.mesh.rotation.z;
            fc.mesh.position.copy(fc.end);
          }
          if (fc.onLand) fc.onLand();
          flyingCards.splice(i, 1);
        }
      }

      // "вариант 2" — дальние соперники визуально крупнее, чтобы карты и таблички были читаемы
      const REF_DIST = 4.5;
      seatMeshes.forEach((g) => {
        const d = camera.position.distanceTo(g.position);
        const scale = THREE.MathUtils.clamp(d / REF_DIST, 1, 1.4);
        g.scale.setScalar(scale);
      });

      renderer.render(scene, camera);
    };
    animate();

    // сцена собрана — просим синхронизировать стол с текущим состоянием
    setSceneVersion((v) => v + 1);

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      sceneApiRef.current = {};
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('deviceorientation', handleOrientation);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, [seatSignature, handleOrientation]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh', background: C.ink, overflow: 'hidden' }}>
      <div ref={mountRef} style={{ position: 'absolute', inset: 0, touchAction: 'none' }} />

      {/* HUD сверху. На телефоне — две компактные строки без наложений. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: isMobile ? 4 : 8,
          padding: isMobile ? '6px 6px 0' : '14px 16px',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.62), transparent)',
          fontFamily: "'Inter', sans-serif",
          zIndex: 30,
          pointerEvents: 'none',
        }}
      >
        {/* Строка 1: выход · комната · козырь и колода */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: isMobile ? 4 : 8,
            pointerEvents: 'auto',
          }}
        >
          <button
            onClick={onExit}
            style={{
              ...hudPill,
              padding: isMobile ? '6px 10px' : '9px 16px',
              fontSize: isMobile ? 11 : 13,
            }}
          >
            ←{isMobile ? '' : ' Выйти'}
          </button>

          <div
            style={{
              ...hudPill,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: isMobile ? '5px 10px' : '6px 14px',
              fontSize: isMobile ? 10.5 : 12,
            }}
          >
            <span style={{ opacity: 0.65 }}>{roomCode}</span>
            <span style={{ opacity: 0.35 }}>·</span>
            <span>
              {rules?.translatable ? 'Перев.' : 'Обыч.'}
              {rules?.pair_defense ? ' · Пары' : ''}
            </span>
          </div>

          <div
            style={{
              ...hudPill,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: isMobile ? '5px 10px' : '6px 14px',
            }}
          >
            <span
              style={{
                fontSize: isMobile ? 15 : 18,
                lineHeight: 1,
                color: game.trump_suit === '♥' || game.trump_suit === '♦' ? '#FF4A55' : C.parchment,
              }}
            >
              {game.trump_suit}
            </span>
            <span style={{ fontSize: isMobile ? 10.5 : 11, opacity: 0.8 }}>
              {game.deck_count}
            </span>
          </div>
        </div>

        {/* Строка 2: чей сейчас ход — отдельной полосой, чтобы ничего не перекрывалось */}
        <div style={{ display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <div
            style={{
              ...hudPill,
              padding: isMobile ? '5px 14px' : '9px 16px',
              fontSize: isMobile ? 11.5 : 13,
              background: iAmDefender
                ? 'rgba(140,31,40,0.9)'
                : iAmAttacker
                ? `linear-gradient(145deg, ${C.goldLight}, ${C.gold})`
                : 'rgba(26,20,16,0.78)',
              color: iAmAttacker ? C.ink : C.parchment,
            }}
          >
            {iAmDefender
              ? '🛡 Ты отбиваешься'
              : iAmAttacker
              ? '⚔ Твой ход'
              : `Ходит ${attackerName}`}
          </div>
        </div>
      </div>

      {/* Панель статусов: видно, кто уже выкинулся, а кто ещё думает */}
      <div
        style={{
          position: 'absolute',
          left: isMobile ? 6 : 12,
          // ниже двухстрочной шапки, чтобы ничего не наезжало
          top: isMobile ? 84 : 108,
          display: 'flex',
          flexDirection: 'column',
          gap: isMobile ? 3 : 5,
          maxWidth: isMobile ? '52%' : 'none',
          fontFamily: "'Inter', sans-serif",
          pointerEvents: 'none',
          zIndex: 20,
        }}
      >
        {players.map((p) => {
          const isDefender = p.pid === game.defender;
          const isAttacker = p.pid === game.attacker;
          const isReady = readySet.has(p.name);
          const offline = !p.connected;
          const border = offline
            ? '#E23B2E'
            : isDefender
            ? 'rgba(232,179,61,0.85)'
            : isReady
            ? 'rgba(90,180,120,0.7)'
            : 'rgba(201,162,39,0.3)';
          return (
            <div
              key={p.pid}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                padding: isMobile ? '3px 8px 3px 6px' : '5px 11px 5px 8px',
                borderRadius: 999,
                background: offline ? 'rgba(120,20,16,0.8)' : 'rgba(26,20,16,0.72)',
                border: `1px solid ${border}`,
                fontSize: isMobile ? 10 : 11.5,
                color: C.parchment,
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ fontSize: 13 }}>
                {offline
                  ? '🔴'
                  : isDefender
                  ? (game.defender_took ? '🫴' : '🛡')
                  : isAttacker
                  ? '⚔'
                  : isReady
                  ? '✅'
                  : '⏳'}
              </span>
              <span style={{ fontWeight: 600 }}>{p.isYou ? 'Ты' : p.name}</span>
              {!isMobile && (
                <span style={{ opacity: 0.65, fontSize: 10 }}>
                  {offline
                    ? 'нет связи'
                    : isDefender
                    ? (game.defender_took ? 'забрал карты' : 'отбивается')
                    : isAttacker
                    ? 'ходит'
                    : isReady
                    ? 'выкинулся'
                    : 'думает'}
                </span>
              )}
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 10,
                  opacity: 0.75,
                  paddingLeft: 6,
                }}
              >
                🃏{p.cardCount}
              </span>
            </div>
          );
        })}
      </div>

      {/* Партия на паузе — кто-то потерял связь */}
      {paused && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(120,16,16,0.34)',
            border: '5px solid #E23B2E',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 40,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              pointerEvents: 'auto',
              background: 'rgba(20,8,6,0.94)',
              border: '2px solid #E23B2E',
              borderRadius: 14,
              padding: '20px 28px',
              textAlign: 'center',
              fontFamily: "'Inter', sans-serif",
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 30, marginBottom: 6 }}>⏸</div>
            <div style={{ color: '#FFD9D4', fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
              {(game.disconnected || []).map((d) => d.name).join(', ')} покинул комнату
            </div>
            <div style={{ color: '#F0B8B2', fontSize: 12, lineHeight: 1.5 }}>
              Партия на паузе. Место и карты сохранены — если игрок вернётся
              с тем же ником, продолжим с этого момента.
            </div>
            {state.lobby.waiting && (
              <div style={{ marginTop: 10 }}>
                {state.lobby.waiting.expired ? (
                  <>
                    <div style={{ color: '#FFD9D4', fontSize: 12, marginBottom: 8 }}>
                      Игрок не вернулся. Можно начать новую партию без него.
                    </div>
                    <button
                      onClick={() => actions.restart()}
                      style={{
                        ...primaryButton,
                        pointerEvents: 'auto',
                        padding: 10,
                        fontSize: 13,
                      }}
                    >
                      Новая партия без него
                    </button>
                  </>
                ) : (
                  <div style={{ color: '#F0B8B2', fontSize: 12 }}>
                    Ждём ещё {state.lobby.waiting.seconds_left} с
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Партия окончена */}
      {finished && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(8,6,4,0.82)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 45,
          }}
        >
          <div
            style={{
              background: `linear-gradient(180deg, ${C.parchment}, ${C.parchmentDark})`,
              border: `3px solid ${C.gold}`,
              borderRadius: 16,
              padding: '26px 30px',
              textAlign: 'center',
              fontFamily: "'Inter', sans-serif",
              maxWidth: 320,
            }}
          >
            <div style={{ fontSize: 40 }}>{game.loser === myPid ? '🃏' : '🏆'}</div>
            <div
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 26,
                fontWeight: 700,
                color: C.ink,
                margin: '6px 0',
              }}
            >
              {game.loser === myPid ? 'Ты — дурак!' : 'Партия окончена'}
            </div>
            <div style={{ fontSize: 13, color: C.inkSoft, marginBottom: 16 }}>
              {game.loser === myPid
                ? 'Не повезло. Отыграешься в следующей партии.'
                : `Проиграл ${game.players.find((p) => p.pid === game.loser)?.name || '—'}`}
            </div>
            {state.last_event?.kind === 'game_over' && (
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  marginBottom: 12,
                  background: state.last_event.epaulette_awarded
                    ? 'rgba(140,31,40,0.12)'
                    : 'rgba(26,20,16,0.06)',
                  border: `1px solid ${
                    state.last_event.epaulette_awarded ? '#B01E2E' : 'rgba(26,20,16,0.15)'
                  }`,
                  fontSize: 12,
                  color: C.ink,
                  lineHeight: 1.5,
                }}
              >
                {state.last_event.epaulette_awarded ? (
                  <>
                    <b>{state.last_event.loser}</b> цепляет погон{' '}
                    <b>{state.last_event.card}</b> — {state.last_event.rank}
                    {state.last_event.skipped && (
                      <div style={{ fontSize: 10.5, color: '#8C1F28', marginTop: 3 }}>
                        Полный комплект из четырёх — ступень пропущена!
                      </div>
                    )}
                  </>
                ) : (
                  <span style={{ color: C.inkSoft }}>
                    {state.last_event.reason || 'Погон в этой партии не засчитан'}
                  </span>
                )}
              </div>
            )}

            <StandingsTable standings={state.lobby.standings || []} myPid={myPid} />

            <div style={{ fontSize: 10.5, color: C.inkSoft, margin: '12px 0 14px' }}>
              Сыграно партий: {state.lobby.games_played || 0}
            </div>

            <button onClick={() => actions.restart()} style={primaryButton}>
              Ещё партию
            </button>
          </div>
        </div>
      )}

      {/* Баннер «БИТО» */}
      {beatBanner && (
        <div
          style={{
            position: 'absolute',
            top: '40%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            padding: isMobile ? '12px 28px' : '18px 42px',
            borderRadius: 16,
            background: 'rgba(11,61,46,0.92)',
            border: `3px solid ${C.goldLight}`,
            color: C.goldLight,
            fontFamily: "'Cormorant Garamond', serif",
            fontWeight: 700,
            fontSize: isMobile ? 30 : 46,
            letterSpacing: isMobile ? 4 : 6,
            pointerEvents: 'none',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          }}
        >
          БИТО
        </div>
      )}

      {/* Баннер «ВЗЯЛ» — когда защищающийся забрал карты */}
      {tookBanner !== null && (
        <div
          style={{
            position: 'absolute',
            top: '40%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            padding: isMobile ? '12px 26px' : '18px 40px',
            borderRadius: 16,
            background: 'rgba(96,20,26,0.93)',
            border: '3px solid #E06A6A',
            color: '#FFD9D4',
            fontFamily: "'Cormorant Garamond', serif",
            fontWeight: 700,
            fontSize: isMobile ? 24 : 36,
            letterSpacing: 3,
            textAlign: 'center',
            pointerEvents: 'none',
            boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          }}
        >
          ВЗЯЛ
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: isMobile ? 11 : 13, letterSpacing: 0, opacity: 0.85, marginTop: 4 }}>
            {tookBanner}
          </div>
        </div>
      )}

      {/* Оповещение: защищающийся взял карты — остальные должны это видеть,
          иначе одни ждут отбоя, а другие ждут «Пока всё!» */}
      {game.defender_took && !paused && !finished && (
        <div
          style={{
            position: 'absolute',
            bottom: isMobile ? 168 : 200,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: isMobile ? '8px 14px' : '10px 20px',
            borderRadius: 12,
            background: 'rgba(96,20,26,0.94)',
            border: '2px solid #E06A6A',
            color: '#FFE3E0',
            fontSize: isMobile ? 11.5 : 13,
            fontWeight: 600,
            fontFamily: "'Inter', sans-serif",
            textAlign: 'center',
            maxWidth: '92%',
            zIndex: 28,
            pointerEvents: 'none',
          }}
        >
          {iAmDefender ? (
            <>🫴 Ты забрал карты — ждём остальных</>
          ) : (
            <>
              🫴 <b>{defenderName}</b> забирает карты
              <div style={{ fontSize: isMobile ? 10 : 11, opacity: 0.85, fontWeight: 400, marginTop: 2 }}>
                Подкинь ещё или нажми «Пока всё!»
              </div>
            </>
          )}
        </div>
      )}

      {/* Ты вышел из партии — просто наблюдаешь за остальными */}
      {!standing && !paused && !finished && iAmOut && (
        <div
          style={{
            position: 'absolute',
            bottom: isMobile ? 96 : 118,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: isMobile ? '7px 16px' : '9px 20px',
            borderRadius: 999,
            background: 'rgba(47,107,71,0.85)',
            border: '1.5px solid #7FD3A1',
            color: '#EAFBF0',
            fontSize: isMobile ? 11.5 : 13,
            fontWeight: 600,
            fontFamily: "'Inter', sans-serif",
            textAlign: 'center',
            zIndex: 25,
            pointerEvents: 'none',
          }}
        >
          Ты закончил — расслабься и наблюдай! 🍃
        </div>
      )}

      {/* Действия: зависят от того, атакуешь ты или защищаешься */}
      {!standing && !paused && !finished && !iAmOut && (
        <div
          style={{
            position: 'absolute',
            bottom: isMobile ? 88 : 108,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: isMobile ? 5 : 8,
            maxWidth: '96%',
            zIndex: 25,
            fontFamily: "'Inter', sans-serif",
          }}
        >
          {iAmDefender ? (
            <>
              <button
                onClick={handleTake}
                disabled={game.table.length === 0 || game.defender_took}
                style={{
                  ...(isMobile ? mobileActionPill : actionPill),
                  background: 'rgba(140,31,40,0.9)',
                  borderColor: '#E06A6A',
                  opacity: game.table.length === 0 || game.defender_took ? 0.4 : 1,
                }}
              >
                🫴 Взять
              </button>
              {rules?.translatable && (
                <>
                  <button
                    onClick={handleTranslate}
                    disabled={selectedIndex === null}
                    style={{ ...(isMobile ? mobileActionPill : actionPill), opacity: selectedIndex === null ? 0.4 : 1 }}
                  >
                    ↷ Перевести
                  </button>
                  <button
                    onClick={handleShowTrump}
                    disabled={selectedIndex === null || (game.trump_shown_by || []).includes(myPid)}
                    title="Козырь того же достоинства — показать, не выкладывая"
                    style={{
                      ...(isMobile ? mobileActionPill : actionPill),
                      opacity:
                        selectedIndex === null || (game.trump_shown_by || []).includes(myPid) ? 0.4 : 1,
                    }}
                  >
                    👁 Показать козырь
                  </button>
                </>
              )}
            </>
          ) : (
            rules?.has_ready_toggle && (
              <button
                onClick={toggleReady}
                disabled={game.table.length === 0}
                style={{
                  ...(isMobile ? mobileActionPill : actionPill),
                  background: iAmReady
                    ? 'linear-gradient(145deg, #4E9A6B, #2F6B47)'
                    : 'rgba(26,20,16,0.82)',
                  borderColor: iAmReady ? '#7FD3A1' : C.gold,
                  color: iAmReady ? '#EAFBF0' : C.parchment,
                  opacity: game.table.length === 0 ? 0.4 : 1,
                }}
              >
                {iAmReady ? '✅ Жду остальных' : '🃏 Пока всё!'}
              </button>
            )
          )}
        </div>
      )}

      {/* Ошибка правил от сервера */}
      {error && Date.now() - error.at < 3200 && (
        <div
          style={{
            position: 'absolute',
            bottom: isMobile ? 140 : 168,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '9px 16px',
            borderRadius: 10,
            background: 'rgba(140,31,40,0.94)',
            border: '1px solid #E06A6A',
            color: '#FFE3E0',
            fontSize: 12.5,
            fontFamily: "'Inter', sans-serif",
            maxWidth: '90%',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          {error.message}
        </div>
      )}

      {/* Показанный козырь — видят все игроки */}
      {shownTrumpCard && (
        <div
          style={{
            position: 'absolute',
            top: '38%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '16px 22px',
            borderRadius: 14,
            background: 'rgba(26,20,16,0.9)',
            border: `2px solid ${C.gold}`,
            fontFamily: "'Inter', sans-serif",
            pointerEvents: 'none',
          }}
        >
          <span style={{ color: C.parchment, fontSize: 12, fontWeight: 600 }}>Показан козырь — перевод</span>
          <div
            style={{
              width: 62,
              height: 88,
              borderRadius: 7,
              background: '#FFFFFF',
              border: `3px solid ${shownTrumpCard.red ? '#E00023' : '#000000'}`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: shownTrumpCard.red ? '#E00023' : '#000000',
              fontFamily: "'Arial Black', Arial, sans-serif",
            }}
          >
            <span style={{ fontSize: 28, lineHeight: 1 }}>{shownTrumpCard.rank}</span>
            <span style={{ fontSize: 26, lineHeight: 1 }}>{shownTrumpCard.suit}</span>
          </div>
        </div>
      )}

      {/* Встать/сесть — приподнять точку обзора над столом */}
      {!paused && !finished && (
        <button
          onClick={toggleStand}
          style={{
            position: 'absolute',
            right: isMobile ? 8 : 14,
            top: isMobile ? '42%' : '50%',
            transform: 'translateY(-50%)',
            padding: isMobile ? '9px 7px' : '12px 10px',
            borderRadius: 12,
            border: `1px solid rgba(201,162,39,0.5)`,
            background: standing ? `linear-gradient(145deg, ${C.goldLight}, ${C.gold})` : 'rgba(26,20,16,0.75)',
            color: standing ? C.ink : C.parchment,
            fontSize: isMobile ? 10.5 : 12,
            fontWeight: 600,
            fontFamily: "'Inter', sans-serif",
            cursor: 'pointer',
            textAlign: 'center',
            lineHeight: 1.3,
            whiteSpace: 'pre-line',
            zIndex: 26,
          }}
        >
          {standing ? '⬇️\nСесть' : '⬆️\nВстать'}
        </button>
      )}

      {/* Рука игрока — 2D оверлей поверх 3D-сцены */}
      <HandOverlay
        hand={orderedHand}
        selectedIndex={selectedIndex}
        hoverIndex={hoverIndex}
        onCardPointerDown={onCardPointerDown}
        cardRefs={cardRefs}
        disabled={standing || paused || finished || iAmOut}
        legalKeys={legalKeys}
        iAmDefender={iAmDefender}
        isMobile={isMobile}
        trumpSuit={game.trump_suit}
      />
    </div>
  );
}

const actionPill = {
  padding: '9px 15px',
  borderRadius: 999,
  background: 'rgba(26,20,16,0.82)',
  color: C.parchment,
  border: `1.5px solid ${C.gold}`,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Inter', sans-serif",
  whiteSpace: 'nowrap',
};

// на телефоне кнопки должны быть меньше, но всё ещё удобными для пальца
const mobileActionPill = {
  ...actionPill,
  padding: '8px 11px',
  fontSize: 11.5,
};

const hudPill = {
  padding: '9px 16px',
  whiteSpace: 'nowrap',
  borderRadius: 999,
  background: 'rgba(26,20,16,0.7)',
  color: C.parchment,
  border: `1px solid rgba(201,162,39,0.5)`,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

function HandOverlay({
  hand,
  selectedIndex,
  hoverIndex,
  onCardPointerDown,
  cardRefs,
  disabled,
  legalKeys,
  iAmDefender,
  isMobile,
  trumpSuit,
}) {
  // На телефоне рука должна помещаться по ширине даже при 8+ картах,
  // поэтому карты сжимаются и накладываются друг на друга веером.
  // Если карт стало МНОГО (взял вместо отбоя), фиксированного сжатия мало —
  // карты за краем экрана были попросту недоступны. Добавляем горизонтальную
  // прокрутку как страховку сверху сжатия.
  const count = Math.max(hand.length, 1);
  const cardW = isMobile ? Math.max(30, Math.min(48, Math.floor((window.innerWidth - 40) / count) - 2)) : 52;
  const cardH = Math.round(cardW * 1.42);
  const overlap = isMobile && count > 6 ? -8 : isMobile ? 3 : 8;
  const needsScroll = isMobile && count > 11; // сжатие уже упёрлось в минимум
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: needsScroll ? 'flex-start' : 'center',
        overflowX: needsScroll ? 'auto' : 'visible',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        gap: overlap,
        padding: isMobile ? '10px 8px 12px' : '18px 12px 22px',
        background: 'linear-gradient(0deg, rgba(0,0,0,0.6), transparent)',
        // 'none' полностью запрещал бы браузерный скролл — при большой руке
        // разрешаем горизонтальный пан, вертикальный свайп-бросок это не ломает,
        // потому что распознаётся он по вертикальному движению.
        touchAction: needsScroll ? 'pan-x' : 'none',
        opacity: disabled ? 0.4 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
        filter: disabled ? 'grayscale(0.6)' : 'none',
        transition: 'opacity 0.2s ease',
      }}
    >
      {hand.map((card, i) => {
        const selected = i === selectedIndex;
        const hovered = i === hoverIndex;
        const fan = (i - (hand.length - 1) / 2) * 4;
        // Защищающийся бьёт чем угодно (сервер проверит старшинство),
        // а вот подкидывать можно только тем, что сервер разрешил.
        const playable =
          iAmDefender || !legalKeys || legalKeys.size === 0
            ? true
            : legalKeys.has(`${card.rank}${card.suit}`);
        const isTrump = card.suit === trumpSuit;
        return (
          <div
            key={card.id}
            ref={(el) => (cardRefs.current[i] = el)}
            onPointerDown={(e) => onCardPointerDown(i, e)}
            style={{
              position: 'relative',
              width: cardW,
              height: cardH,
              borderRadius: 6,
              opacity: playable ? 1 : 0.42,
              filter: playable ? 'none' : 'grayscale(0.8)',
              background: hovered ? '#FFF7E0' : isTrump ? '#FFF9E3' : '#FBFAF5',
              border: hovered
                ? `2.5px solid ${C.goldLight}`
                : isTrump
                ? `2.5px solid ${C.gold}`
                : `1.5px solid ${card.red ? '#4C6FA5' : '#3A3A3A'}`,
              boxShadow: selected
                ? '0 14px 26px rgba(0,0,0,0.65)'
                : hovered
                ? `0 6px 14px rgba(0,0,0,0.5), 0 0 14px ${C.goldLight}`
                : '0 6px 14px rgba(0,0,0,0.5)',
              fontFamily: "'Georgia', serif",
              fontWeight: 700,
              color: card.red ? '#B01E2E' : '#171310',
              transform: selected
                ? `translateY(${Math.abs(i - 2.5) * 4 - 34}px) rotate(0deg) scale(1.12)`
                : hovered
                ? `translateY(${Math.abs(i - 2.5) * 4 - 8}px) rotate(${fan}deg) scale(1.05)`
                : `translateY(${Math.abs(i - 2.5) * 4}px) rotate(${fan}deg)`,
              outline: selected ? `2px solid ${C.goldLight}` : 'none',
              transition: 'transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease',
              flexShrink: 0,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <span style={{ position: 'absolute', top: 2, left: 4, fontSize: Math.round(cardW * 0.23), lineHeight: 1.1 }}>
              {card.rank}
              <br />
              {card.suit}
            </span>
            <span
              style={{
                position: 'absolute',
                bottom: 2,
                right: 4,
                fontSize: Math.round(cardW * 0.23),
                lineHeight: 1.1,
                transform: 'rotate(180deg)',
              }}
            >
              {card.rank}
              <br />
              {card.suit}
            </span>
            <span
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%,-50%)',
                fontSize: Math.round(cardW * 0.42),
              }}
            >
              {card.suit}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ============ ВСПОМОГАТЕЛЬНЫЕ: ТЕКСТУРЫ ============
function makeTextSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(26,20,16,0.75)';
  roundRect(ctx, 4, 4, 248, 56, 14);
  ctx.fill();
  ctx.strokeStyle = C.gold;
  ctx.lineWidth = 2;
  roundRect(ctx, 4, 4, 248, 56, 14);
  ctx.stroke();
  ctx.fillStyle = C.parchment;
  ctx.font = '600 28px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 34);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.9, 0.22, 1);
  return sprite;
}

// ---- Рубашка карты: крупный контрастный узор, читаемый на реальном экранном размере ----
function makeCardBackTexture() {
  const W = 512, H = 716;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const navy = '#16386B';

  // белое поле
  ctx.fillStyle = '#F7F4EC';
  roundRect(ctx, 0, 0, W, H, 30);
  ctx.fill();

  // сплошная синяя заливка внутри с белым полем по краю
  const m = 34;
  ctx.fillStyle = navy;
  roundRect(ctx, m, m, W - m * 2, H - m * 2, 18);
  ctx.fill();

  // крупная диагональная решётка поверх — узор виден даже когда карта мелкая
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, m, m, W - m * 2, H - m * 2, 18);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 6;
  for (let i = -H; i < W + H; i += 46) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + H, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(i + H, 0);
    ctx.lineTo(i, H);
    ctx.stroke();
  }
  ctx.restore();

  // центральный медальон
  const cx = W / 2, cy = H / 2;
  ctx.fillStyle = '#F7F4EC';
  ctx.beginPath();
  ctx.arc(cx, cy, 108, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = navy;
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(cx, cy, 108, 0, Math.PI * 2);
  ctx.stroke();

  // звезда-розетка внутри медальона
  ctx.fillStyle = navy;
  const rays = 16;
  ctx.beginPath();
  for (let i = 0; i < rays * 2; i++) {
    const a = (i / (rays * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? 82 : 38;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

// ---- Масти рисуем векторными фигурами, а не символами шрифта — так они гарантированно видны на любой системе ----
function drawSuitShape(ctx, suit, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  const s = size;
  if (suit === '♦') {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.55);
    ctx.lineTo(s * 0.36, 0);
    ctx.lineTo(0, s * 0.55);
    ctx.lineTo(-s * 0.36, 0);
    ctx.closePath();
    ctx.fill();
  } else if (suit === '♥') {
    ctx.beginPath();
    ctx.moveTo(0, s * 0.15);
    ctx.bezierCurveTo(-s * 0.5, -s * 0.35, -s * 0.5, s * 0.05, 0, s * 0.5);
    ctx.bezierCurveTo(s * 0.5, s * 0.05, s * 0.5, -s * 0.35, 0, s * 0.15);
    ctx.fill();
  } else if (suit === '♠') {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.5);
    ctx.bezierCurveTo(s * 0.5, -s * 0.05, s * 0.5, s * 0.35, 0, s * 0.14);
    ctx.bezierCurveTo(-s * 0.5, s * 0.35, -s * 0.5, -s * 0.05, 0, -s * 0.5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.12, s * 0.14);
    ctx.lineTo(s * 0.12, s * 0.14);
    ctx.lineTo(s * 0.06, s * 0.5);
    ctx.lineTo(-s * 0.06, s * 0.5);
    ctx.closePath();
    ctx.fill();
  } else {
    const r = s * 0.22;
    ctx.beginPath();
    ctx.arc(0, -r * 1.1, r, 0, Math.PI * 2);
    ctx.arc(-r * 1.1, r * 0.45, r, 0, Math.PI * 2);
    ctx.arc(r * 1.1, r * 0.45, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-s * 0.1, s * 0.14);
    ctx.lineTo(s * 0.1, s * 0.14);
    ctx.lineTo(s * 0.05, s * 0.5);
    ctx.lineTo(-s * 0.05, s * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---- Лицевая сторона карты: крупная читаемая метка, рассчитанная на просмотр под углом и издалека ----
function makeCardFaceTexture(rank, suit) {
  const W = 512, H = 716; // высокое разрешение — иначе детали рассыпаются под углом
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const isRed = suit === '♥' || suit === '♦';
  const suitColor = isRed ? '#E00023' : '#000000';

  // фон
  ctx.fillStyle = '#FFFFFF';
  roundRect(ctx, 0, 0, W, H, 30);
  ctx.fill();

  // жирная цветная рамка — сразу читается масть даже если карта далеко
  ctx.strokeStyle = suitColor;
  ctx.lineWidth = 16;
  roundRect(ctx, 12, 12, W - 24, H - 24, 24);
  ctx.stroke();

  // крупный ранг по центру верхней части
  ctx.fillStyle = suitColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${rank === '10' ? 230 : 265}px Arial Black, Arial, sans-serif`;
  ctx.fillText(rank, W / 2, H * 0.35);

  // крупная масть под рангом
  drawSuitShape(ctx, suit, W / 2, H * 0.71, 235, suitColor);

  // зеркальные индексы в углах — карта читается и в перевёрнутом положении
  const drawCornerIndex = (flip) => {
    ctx.save();
    ctx.translate(W / 2, H / 2);
    if (flip) ctx.rotate(Math.PI);
    ctx.translate(-W / 2, -H / 2);
    ctx.fillStyle = suitColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${rank === '10' ? 62 : 72}px Arial Black, Arial, sans-serif`;
    ctx.fillText(rank, 62, 72);
    drawSuitShape(ctx, suit, 62, 148, 62, suitColor);
    ctx.restore();
  };
  drawCornerIndex(false);
  drawCornerIndex(true);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ============ КОМНАТА: ПОЛ, СТЕНЫ, КАРТИНЫ, БАР, ЛАМПА ============

const ROOM_HALF = 7.5;
const ROOM_HEIGHT = 5;
const FLOOR_Y = -0.16;

function makeFloorTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0A2A1D';
  ctx.fillRect(0, 0, size, size);
  // лёгкий узор ковра — концентрические ромбы
  ctx.strokeStyle = 'rgba(201,162,39,0.06)';
  ctx.lineWidth = 2;
  for (let r = 20; r < size; r += 46) {
    ctx.strokeRect(size / 2 - r, size / 2 - r, r * 2, r * 2);
  }
  // звёздочки-точки
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const rad = Math.random() * 1.4 + 0.3;
    const warm = Math.random() > 0.5;
    ctx.fillStyle = warm ? 'rgba(230,199,102,0.75)' : 'rgba(243,233,210,0.55)';
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  return tex;
}

function makeFrameTexture(seed) {
  const canvas = document.createElement('canvas');
  canvas.width = 300;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');

  // рама
  ctx.fillStyle = C.gold;
  ctx.fillRect(0, 0, 300, 400);
  const pad = 16;
  const grad = ctx.createLinearGradient(0, pad, 0, 400 - pad);
  const palettes = [
    ['#2B1B12', '#4A3220', '#8C1F28'],
    ['#0B3D2E', '#062A1E', '#C9A227'],
    ['#3A2C22', '#1A1410', '#E6C766'],
  ];
  const p = palettes[seed % palettes.length];
  grad.addColorStop(0, p[0]);
  grad.addColorStop(1, p[1]);
  ctx.fillStyle = grad;
  ctx.fillRect(pad, pad, 300 - pad * 2, 400 - pad * 2);

  // абстрактный мотив — силуэт, диск (луна/монета), линия горизонта
  ctx.fillStyle = p[2];
  ctx.globalAlpha = 0.8;
  ctx.beginPath();
  ctx.arc(150 + (seed % 3) * 20 - 20, 140, 34, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.moveTo(pad, 260);
  ctx.lineTo(300 - pad, 230 + (seed % 2) * 30);
  ctx.lineTo(300 - pad, 400 - pad);
  ctx.lineTo(pad, 400 - pad);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

function buildRoom(scene) {
  // ---- Пол: тёмно-зелёный ковёр со звёздочками ----
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2),
    new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.95 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  scene.add(floor);

  // ---- Стены ----
  const wallMat = new THREE.MeshStandardMaterial({ color: C.inkSoft, roughness: 0.9, side: THREE.DoubleSide });
  const wallGeo = new THREE.PlaneGeometry(ROOM_HALF * 2, ROOM_HEIGHT);
  const wallY = FLOOR_Y + ROOM_HEIGHT / 2;

  const back = new THREE.Mesh(wallGeo, wallMat);
  back.position.set(0, wallY, -ROOM_HALF);
  scene.add(back);

  const front = new THREE.Mesh(wallGeo, wallMat);
  front.position.set(0, wallY, ROOM_HALF);
  front.rotation.y = Math.PI;
  scene.add(front);

  const left = new THREE.Mesh(wallGeo, wallMat);
  left.position.set(-ROOM_HALF, wallY, 0);
  left.rotation.y = Math.PI / 2;
  scene.add(left);

  const right = new THREE.Mesh(wallGeo, wallMat);
  right.position.set(ROOM_HALF, wallY, 0);
  right.rotation.y = -Math.PI / 2;
  scene.add(right);

  // деревянные плинтусы вдоль стен для уюта
  const skirtMat = new THREE.MeshStandardMaterial({ color: C.wood, roughness: 0.7 });
  [
    [0, -ROOM_HALF, 0],
    [0, ROOM_HALF, Math.PI],
    [-ROOM_HALF, 0, Math.PI / 2],
    [ROOM_HALF, 0, -Math.PI / 2],
  ].forEach(([x, z, ry]) => {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(ROOM_HALF * 2, 0.3, 0.06), skirtMat);
    skirt.position.set(x, FLOOR_Y + 0.15, z);
    skirt.rotation.y = ry;
    scene.add(skirt);
  });

  // ---- Картины на задней и боковых стенах ----
  const framePositions = [
    { x: -2.4, z: -ROOM_HALF + 0.03, ry: 0, seed: 0 },
    { x: 2.4, z: -ROOM_HALF + 0.03, ry: 0, seed: 1 },
    { x: -ROOM_HALF + 0.03, z: 2.5, ry: Math.PI / 2, seed: 2 },
    { x: ROOM_HALF - 0.03, z: 2.5, ry: -Math.PI / 2, seed: 0 },
  ];
  framePositions.forEach(({ x, z, ry, seed }) => {
    const painting = new THREE.Mesh(
      new THREE.PlaneGeometry(1.3, 1.75),
      new THREE.MeshStandardMaterial({ map: makeFrameTexture(seed), roughness: 0.6 })
    );
    painting.position.set(x, 2.6, z);
    painting.rotation.y = ry;
    scene.add(painting);

    const sconce = new THREE.PointLight(0xffb35c, 0.7, 4);
    sconce.position.set(x, 3.5, z + (ry === 0 ? 0.5 : 0));
    scene.add(sconce);
  });
}

function buildBar(scene) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: C.wood, roughness: 0.7 });
  const topMat = new THREE.MeshStandardMaterial({ color: C.goldLight, metalness: 0.3, roughness: 0.4 });

  // стойка вдоль левой стены
  const counter = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.05, 4.2), woodMat);
  counter.position.set(-ROOM_HALF + 0.9, FLOOR_Y + 0.525, -1.2);
  group.add(counter);

  const top = new THREE.Mesh(new THREE.BoxGeometry(1.06, 0.06, 4.3), topMat);
  top.position.set(-ROOM_HALF + 0.9, FLOOR_Y + 1.08, -1.2);
  group.add(top);

  // полки на стене за стойкой
  const shelfMat = new THREE.MeshStandardMaterial({ color: C.woodLight, roughness: 0.6 });
  [1.9, 2.6, 3.3].forEach((y) => {
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.05, 4.2), shelfMat);
    shelf.position.set(-ROOM_HALF + 0.25, FLOOR_Y + y, -1.2);
    group.add(shelf);

    const bottleCount = 6;
    for (let i = 0; i < bottleCount; i++) {
      const z = -1.2 - 1.9 + (i / (bottleCount - 1)) * 3.8;
      group.add(makeBottle(-ROOM_HALF + 0.25, FLOOR_Y + y + 0.03, z));
    }
  });

  scene.add(group);
}

function makeBottle(x, y, z) {
  const palette = [
    { body: '#2E5339', h: 0.42 }, // зелёное стекло
    { body: '#8C1F28', h: 0.4 }, // вино
    { body: '#D8B27C', h: 0.36 }, // виски/бренди
    { body: '#EDEFE9', h: 0.3 }, // прозрачная (водка)
  ];
  const p = palette[Math.floor(Math.random() * palette.length)];
  const g = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.06, p.h, 10),
    new THREE.MeshStandardMaterial({ color: p.body, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.92 })
  );
  body.position.y = p.h / 2;
  g.add(body);

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.03, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: p.body, roughness: 0.25, transparent: true, opacity: 0.92 })
  );
  neck.position.y = p.h + 0.06;
  g.add(neck);

  g.position.set(x, y, z);
  g.rotation.y = Math.random() * Math.PI;
  return g;
}

function buildLampFixture(scene, pos) {
  const group = new THREE.Group();

  const cord = new THREE.Mesh(
    new THREE.CylinderGeometry(0.015, 0.015, ROOM_HEIGHT - pos.y + FLOOR_Y + 0.4, 6),
    new THREE.MeshStandardMaterial({ color: C.ink })
  );
  cord.position.set(0, pos.y + (ROOM_HEIGHT - pos.y + FLOOR_Y) / 2, 0);
  group.add(cord);

  const shade = new THREE.Mesh(
    new THREE.ConeGeometry(0.5, 0.42, 24, 1, true),
    new THREE.MeshStandardMaterial({
      color: C.gold,
      emissive: new THREE.Color('#5a4318'),
      emissiveIntensity: 0.6,
      roughness: 0.4,
      side: THREE.DoubleSide,
    })
  );
  shade.position.set(pos.x, pos.y + 0.28, pos.z);
  group.add(shade);

  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 12),
    new THREE.MeshStandardMaterial({ color: '#FFE9B8', emissive: '#FFD08A', emissiveIntensity: 1.4 })
  );
  bulb.position.set(pos.x, pos.y, pos.z);
  group.add(bulb);

  scene.add(group);
}
