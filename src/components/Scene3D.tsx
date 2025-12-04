'use client';

import { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getWalls, getWallMeshes, getFurniture, getLights, getSpawns, getMapSize, getRandomSpawn } from '../utils/mapLoader';
import { useMultiplayer, RemotePlayer, RemoteProjectile, RemoteFireZone } from '../hooks/useMultiplayer';
import { RemotePlayers, RemoteProjectiles, RemoteFireZones } from './RemotePlayers';

// URL du serveur multijoueur
const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3001';

interface GameSettings {
  flashlightAngle: number;
  flashlightIntensity: number;
  playerSpeed: number;
  ambientLight: number;
}

interface VisionData {
  playerX: number;
  playerZ: number;
  visibleRadius: number;
  walls: Array<{ x: number; z: number; width: number; depth: number }>;
  raycastPoints: Array<{ x: number; z: number }>;
  mouseAngle: number;
}

// Interface pour les callbacks multijoueur
interface MultiplayerCallbacks {
  sendMove: (x: number, z: number, angle: number) => void;
  sendShoot: (projectiles: Array<{ x: number; z: number; vx: number; vz: number; damage: number }>) => void;
  sendMolotov: (x: number, z: number, radius: number) => void;
  sendToggleFlashlight: (on: boolean) => void;
}

function Player({ settings, setVisionData, showRaycast, setPlayerStamina, setPlayerHealth, multiplayer }: { 
  settings: GameSettings; 
  setVisionData: (data: VisionData) => void;
  showRaycast: boolean;
  setPlayerStamina: (fn: (prev: number) => number) => void;
  setPlayerHealth: (fn: (prev: number) => number) => void;
  multiplayer?: MultiplayerCallbacks;
}) {
  const playerRef = useRef<THREE.Mesh>(null);
  const shotgunRef = useRef<THREE.Group>(null);
  const pistolRef = useRef<THREE.Group>(null);
  const spotLightRef = useRef<THREE.SpotLight>(null);
  const muzzleFlashRef = useRef<THREE.PointLight>(null);
  const targetRef = useRef<THREE.Object3D>(new THREE.Object3D());
  const keysRef = useRef({ z: false, q: false, s: false, d: false, shift: false });
  const [flashlightOn, setFlashlightOn] = useState(false);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [projectiles, setProjectiles] = useState<Array<{ id: number; x: number; z: number; vx: number; vz: number; life: number; damage: number }>>([]);
  const [molotovs, setMolotovs] = useState<Array<{ id: number; x: number; z: number; vx: number; vz: number; vy: number; y: number; life: number }>>([]);
  const [fireZones, setFireZones] = useState<Array<{ id: number; x: number; z: number; life: number; radius: number }>>([]);
  const [muzzleFlash, setMuzzleFlash] = useState(false);
  const [currentWeapon, setCurrentWeapon] = useState<'shotgun' | 'pistol'>('shotgun');
  const molotovIdCounter = useRef(0);
  const fireZoneIdCounter = useRef(0);
  const staminaRef = useRef(100);
  const velocity = useRef({ x: 0, z: 0 });
  const shotgunAngle = useRef(0);
  const projectileIdCounter = useRef(0);
  const lightDirection = useRef({ x: 0, z: 1 });
  
  // Objets réutilisables pour éviter les allocations à chaque frame
  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseVec2Ref = useRef(new THREE.Vector2());
  const groundPlaneRef = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const intersectionRef = useRef(new THREE.Vector3());
  
  const [currentVisionData, setCurrentVisionData] = useState<VisionData>({ 
    playerX: 0, 
    playerZ: 0, 
    visibleRadius: 50,
    walls: [],
    raycastPoints: [],
    mouseAngle: 0
  });
  
  // Audio refs
  const shotgunFireAudio = useRef<{ play: () => void } | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  
  // Audio raytracing: calculate volume and stereo based on distance and walls
  const calculateAudioParameters = (sourceX: number, sourceZ: number, listenerX: number, listenerZ: number) => {
    const dx = sourceX - listenerX;
    const dz = sourceZ - listenerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Check if sound path is blocked by walls
    let blocked = false;
    const numSamples = Math.ceil(distance / 0.5);
    
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      const sampleX = listenerX + dx * t;
      const sampleZ = listenerZ + dz * t;
      
      for (const wall of walls) {
        const halfWidth = wall.width / 2;
        const halfDepth = wall.depth / 2;
        const minX = wall.x - halfWidth;
        const maxX = wall.x + halfWidth;
        const minZ = wall.z - halfDepth;
        const maxZ = wall.z + halfDepth;
        
        if (sampleX >= minX && sampleX <= maxX && sampleZ >= minZ && sampleZ <= maxZ) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
    }
    
    // Volume falloff with distance (inverse square law)
    let volume = 1.0 / (1.0 + distance * 0.05);
    
    // Reduce volume if blocked by wall
    if (blocked) {
      volume *= 0.15; // Muffled sound through walls
    }
    
    // Stereo panning based on angle
    const angle = Math.atan2(dx, dz);
    const pan = Math.sin(angle) * 0.8; // -0.8 to 0.8
    
    return { volume: Math.min(volume, 1.0), pan };
  };
  
  // Définir les obstacles (murs) depuis la map JSON
  const walls = getWalls();
  
  const checkCollision = (newX: number, newZ: number) => {
    const playerRadius = 0.5;
    
    for (const wall of walls) {
      const halfWidth = wall.width / 2;
      const halfDepth = wall.depth / 2;
      
      // Calculer les limites du mur
      const minX = wall.x - halfWidth;
      const maxX = wall.x + halfWidth;
      const minZ = wall.z - halfDepth;
      const maxZ = wall.z + halfDepth;
      
      // Vérifier la collision avec le cercle du joueur
      const closestX = Math.max(minX, Math.min(newX, maxX));
      const closestZ = Math.max(minZ, Math.min(newZ, maxZ));
      
      const distanceX = newX - closestX;
      const distanceZ = newZ - closestZ;
      const distanceSquared = distanceX * distanceX + distanceZ * distanceZ;
      
      if (distanceSquared < playerRadius * playerRadius) {
        return true; // Collision détectée
      }
    }
    
    return false; // Pas de collision
  };
  
  useEffect(() => {
    // Initialize audio with beep sound and raytracing
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioContextRef.current = audioContext;
    
    const playBeep = () => {
      if (!playerRef.current) return;
      
      // Calculate audio parameters based on player position
      const sourceX = playerRef.current.position.x;
      const sourceZ = playerRef.current.position.z;
      const { volume, pan } = calculateAudioParameters(sourceX, sourceZ, sourceX, sourceZ);
      
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      const pannerNode = audioContext.createStereoPanner();
      
      oscillator.connect(gainNode);
      gainNode.connect(pannerNode);
      pannerNode.connect(audioContext.destination);
      
      // Realistic shotgun sound: low frequency blast
      oscillator.frequency.value = 120; // Lower frequency for shotgun
      oscillator.type = 'sawtooth';
      
      pannerNode.pan.value = pan;
      
      gainNode.gain.setValueAtTime(0.6 * volume, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
      
      // Add click sound for realism
      const clickOsc = audioContext.createOscillator();
      const clickGain = audioContext.createGain();
      const clickPanner = audioContext.createStereoPanner();
      
      clickOsc.connect(clickGain);
      clickGain.connect(clickPanner);
      clickPanner.connect(audioContext.destination);
      
      clickOsc.frequency.value = 800;
      clickOsc.type = 'square';
      clickPanner.pan.value = pan;
      
      clickGain.gain.setValueAtTime(0.3 * volume, audioContext.currentTime);
      clickGain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.02);
      
      clickOsc.start(audioContext.currentTime);
      clickOsc.stop(audioContext.currentTime + 0.02);
    };
    
    shotgunFireAudio.current = { play: playBeep } as any;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (['z', 'q', 's', 'd'].includes(key)) {
        keysRef.current[key as 'z' | 'q' | 's' | 'd'] = true;
      }
      if (e.key === 'Shift') {
        keysRef.current.shift = true;
      }
      if (key === 'e') {
        setFlashlightOn(prev => {
          const newState = !prev;
          multiplayer?.sendToggleFlashlight(newState);
          return newState;
        });
      }
      if (key === 'g' && playerRef.current) {
        // Lancer un cocktail Molotov
        const angle = shotgunAngle.current;
        const speed = 15;
        const molotovX = playerRef.current!.position.x;
        const molotovZ = playerRef.current!.position.z;
        
        setMolotovs(prev => [...prev, {
          id: molotovIdCounter.current++,
          x: molotovX,
          z: molotovZ,
          vx: Math.sin(angle) * speed,
          vz: Math.cos(angle) * speed,
          vy: 8, // Vélocité verticale initiale
          y: 1,
          life: 3
        }]);
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (['z', 'q', 's', 'd'].includes(key)) {
        keysRef.current[key as 'z' | 'q' | 's' | 'd'] = false;
      }
      if (e.key === 'Shift') {
        keysRef.current.shift = false;
      }
    };
    
    const handleMouseMove = (e: MouseEvent) => {
      setMousePos({
        x: (e.clientX / window.innerWidth) * 2 - 1,
        y: -(e.clientY / window.innerHeight) * 2 + 1
      });
    };
    
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Seulement clic gauche
      if (!playerRef.current) return;
      
      // Play beep sound
      if (shotgunFireAudio.current) {
        shotgunFireAudio.current.play();
      }
      
      // Déclencher le flash du fusil
      setMuzzleFlash(true);
      setTimeout(() => setMuzzleFlash(false), 50);
      
      const newProjectiles: typeof projectiles = [];
      const networkProjectiles: Array<{ x: number; z: number; vx: number; vz: number; damage: number }> = [];
      
      if (currentWeapon === 'shotgun') {
        // Fusil à pompe : 20 projectiles avec dispersion
        for (let i = 0; i < 20; i++) {
          const spreadAngle = (Math.random() - 0.5) * 0.4; // Dispersion aléatoire
          const angle = shotgunAngle.current + spreadAngle;
          const speed = 50 + Math.random() * 10;
          
          const proj = {
            id: projectileIdCounter.current++,
            x: playerRef.current.position.x,
            z: playerRef.current.position.z,
            vx: Math.sin(angle) * speed,
            vz: Math.cos(angle) * speed,
            life: 1.5, // Durée de vie en secondes
            damage: 10 // dégâts par projectile
          };
          
          newProjectiles.push(proj);
          networkProjectiles.push({
            x: proj.x,
            z: proj.z,
            vx: proj.vx,
            vz: proj.vz,
            damage: proj.damage
          });
        }
      } else if (currentWeapon === 'pistol') {
        // Pistolet : 1 projectile précis, plus rapide, plus de dégâts
        const angle = shotgunAngle.current;
        const speed = 80; // Plus rapide que le shotgun
        
        const proj = {
          id: projectileIdCounter.current++,
          x: playerRef.current.position.x,
          z: playerRef.current.position.z,
          vx: Math.sin(angle) * speed,
          vz: Math.cos(angle) * speed,
          life: 2, // Durée de vie plus longue
          damage: 35 // Plus de dégâts par balle
        };
        
        newProjectiles.push(proj);
        networkProjectiles.push({
          x: proj.x,
          z: proj.z,
          vx: proj.vx,
          vz: proj.vz,
          damage: proj.damage
        });
      }
      
      setProjectiles(prev => [...prev, ...newProjectiles]);
      
      // Envoyer les projectiles au serveur
      multiplayer?.sendShoot(networkProjectiles);
    };
    
    // Changement d'arme avec la molette
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCurrentWeapon(prev => {
        const newWeapon = prev === 'shotgun' ? 'pistol' : 'shotgun';
        // Émettre un événement pour l'UI
        window.dispatchEvent(new CustomEvent('weaponChange', { detail: { weapon: newWeapon } }));
        return newWeapon;
      });
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('wheel', handleWheel, { passive: false });
    
    // Écouter l'événement de respawn
    const handleRespawn = () => {
      if (playerRef.current) {
        const spawn = getRandomSpawn();
        playerRef.current.position.x = spawn.x;
        playerRef.current.position.z = spawn.z;
        staminaRef.current = 100;
      }
    };
    window.addEventListener('playerRespawn', handleRespawn);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('playerRespawn', handleRespawn);
    };
  }, [currentWeapon]);
  
  useFrame((state, delta) => {
    if (!playerRef.current) return;
    
    // Mettre à jour les projectiles
    setProjectiles(prev => {
      // @ts-ignore
      const hitProjectiles: number[] = window.__hitProjectiles || [];
      return prev
        .filter(p => !hitProjectiles.includes(p.id)) // Retirer les projectiles qui ont touché
        .map(p => {
          const newX = p.x + p.vx * delta;
          const newZ = p.z + p.vz * delta;
          
          // Vérifier collision avec les murs
          if (checkCollision(newX, newZ)) {
            return null; // Marquer pour suppression
          }
          
          return {
            ...p,
            x: newX,
            z: newZ,
            life: p.life - delta
          };
        })
        .filter(p => p !== null && p.life > 0 && Math.abs(p.x) < 100 && Math.abs(p.z) < 100) as typeof prev;
    });
    
    // Nettoyer la liste des projectiles touchés
    // @ts-ignore
    window.__hitProjectiles = [];
    
    // Exposer les projectiles pour le bot
    // @ts-ignore
    window.__playerProjectiles = projectiles;
    
    // Mettre à jour les molotovs (physique parabolique)
    setMolotovs(prev => {
      const stillFlying: typeof prev = [];
      const newFireZones: typeof fireZones = [];
      
      for (const m of prev) {
        const newX = m.x + m.vx * delta;
        const newZ = m.z + m.vz * delta;
        const newY = m.y + m.vy * delta;
        const newVy = m.vy - 15 * delta; // Gravité
        
        // Si le molotov touche le sol ou un mur
        if (newY <= 0 || checkCollision(newX, newZ)) {
          // Créer une zone de feu
          const fireZone = {
            id: fireZoneIdCounter.current++,
            x: m.x,
            z: m.z,
            life: 5, // 5 secondes de feu
            radius: 3
          };
          newFireZones.push(fireZone);
          
          // Envoyer au serveur
          multiplayer?.sendMolotov(m.x, m.z, 3);
        } else {
          stillFlying.push({
            ...m,
            x: newX,
            z: newZ,
            y: newY,
            vy: newVy,
            life: m.life - delta
          });
        }
      }
      
      if (newFireZones.length > 0) {
        setFireZones(fz => [...fz, ...newFireZones]);
      }
      
      return stillFlying.filter(m => m.life > 0);
    });
    
    // Mettre à jour les zones de feu
    setFireZones(prev => 
      prev
        .map(f => ({ ...f, life: f.life - delta }))
        .filter(f => f.life > 0)
    );
    
    // Exposer les zones de feu pour le bot
    // @ts-ignore
    window.__fireZones = fireZones;
    
    // Calculer la vélocité basée sur les touches pressées
    velocity.current.x = 0;
    velocity.current.z = 0;
    
    const keys = keysRef.current;
    const isMoving = keys.z || keys.q || keys.s || keys.d;
    const canSprint = staminaRef.current > 0;
    const isSprinting = keys.shift && isMoving && canSprint;
    const sprintMultiplier = isSprinting ? 2 : 1;
    const currentSpeed = settings.playerSpeed * sprintMultiplier;
    
    // Gérer l'endurance
    if (isSprinting) {
      staminaRef.current = Math.max(0, staminaRef.current - 20 * delta);
      setPlayerStamina(() => staminaRef.current);
    } else if (staminaRef.current < 100) {
      staminaRef.current = Math.min(100, staminaRef.current + 10 * delta);
      setPlayerStamina(() => staminaRef.current);
    }
    
    // Dégâts des zones de feu sur le joueur
    const playerX = playerRef.current.position.x;
    const playerZ = playerRef.current.position.z;
    for (const f of fireZones) {
      const dx = playerX - f.x;
      const dz = playerZ - f.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < f.radius) {
        // 15 dégâts par seconde dans le feu
        setPlayerHealth(h => Math.max(0, h - 15 * delta));
        break; // Un seul tick de dégâts par frame même si dans plusieurs zones
      }
    }
    
    if (keys.z) velocity.current.z -= currentSpeed * delta;
    if (keys.s) velocity.current.z += currentSpeed * delta;
    if (keys.q) velocity.current.x -= currentSpeed * delta;
    if (keys.d) velocity.current.x += currentSpeed * delta;
    
    // Normaliser la vélocité en diagonale
    if (velocity.current.x !== 0 && velocity.current.z !== 0) {
      const factor = Math.sqrt(2) / 2;
      velocity.current.x *= factor;
      velocity.current.z *= factor;
    }
    
    // Appliquer le mouvement avec détection de collision
    const newX = playerRef.current.position.x + velocity.current.x;
    const newZ = playerRef.current.position.z + velocity.current.z;
    
    // Vérifier les collisions séparément pour X et Z
    if (!checkCollision(newX, playerRef.current.position.z)) {
      playerRef.current.position.x = newX;
    }
    
    if (!checkCollision(playerRef.current.position.x, newZ)) {
      playerRef.current.position.z = newZ;
    }
    
    // Limiter aux bords de la map (140x80, donc -70 à +70 en X, -40 à +40 en Z)
    const mapSize = getMapSize();
    playerRef.current.position.x = Math.max(-70, Math.min(70, playerRef.current.position.x));
    playerRef.current.position.z = Math.max(-40, Math.min(40, playerRef.current.position.z));
    
    // Mettre à jour la position et direction de la lampe torche
    if (spotLightRef.current && targetRef.current) {
      // Position de la lampe sur le personnage
      spotLightRef.current.position.copy(playerRef.current.position);
      spotLightRef.current.position.y = 1;
      
      // Convertir la position de la souris en coordonnées monde (réutiliser les objets)
      mouseVec2Ref.current.set(mousePos.x, mousePos.y);
      raycasterRef.current.setFromCamera(mouseVec2Ref.current, state.camera);
      raycasterRef.current.ray.intersectPlane(groundPlaneRef.current, intersectionRef.current);
      
      // Raymarching pour détecter collision avec les murs
      const dirX = intersectionRef.current.x - playerRef.current.position.x;
      const dirZ = intersectionRef.current.z - playerRef.current.position.z;
      const maxDistance = Math.sqrt(dirX * dirX + dirZ * dirZ);
      const dirNormX = dirX / maxDistance;
      const dirNormZ = dirZ / maxDistance;
      
      let rayX = playerRef.current.position.x;
      let rayZ = playerRef.current.position.z;
      let marchDistance = 0;
      const marchStep = 0.3; // Pas de raymarching
      
      // Raymarching
      while (marchDistance < maxDistance) {
        // Calculer la distance minimum à tous les murs
        let minDist = Infinity;
        
        for (const wall of walls) {
          const halfWidth = wall.width / 2;
          const halfDepth = wall.depth / 2;
          
          // Distance au rectangle (SDF) - avec une marge de sécurité
          const dx = Math.abs(rayX - wall.x) - halfWidth;
          const dz = Math.abs(rayZ - wall.z) - halfDepth;
          
          // Si on est à l'intérieur du rectangle sur les deux axes
          if (dx < 0 && dz < 0) {
            minDist = 0;
            break;
          }
          
          // Distance au bord du rectangle
          const dist = dx > 0 && dz > 0 
            ? Math.sqrt(dx * dx + dz * dz) // Coin
            : Math.max(dx, dz); // Bord
          
          minDist = Math.min(minDist, dist);
        }
        
        // Si on est très proche d'un mur ou dedans, on arrête
        if (minDist <= 0.5) {
          break;
        }
        
        // Avancer du minimum de la distance au mur ou du pas
        const step = Math.min(Math.max(minDist * 0.9, 0.1), marchStep);
        rayX += dirNormX * step;
        rayZ += dirNormZ * step;
        marchDistance += step;
      }
      
      // Faire pointer la lampe vers la position calculée par raymarching
      targetRef.current.position.set(rayX, 0, rayZ);
      spotLightRef.current.target = targetRef.current;
      spotLightRef.current.target.updateMatrixWorld();
      
      // Calculer l'angle du fusil vers la souris
      const dx = intersectionRef.current.x - playerRef.current.position.x;
      const dz = intersectionRef.current.z - playerRef.current.position.z;
      shotgunAngle.current = Math.atan2(dx, dz);
      const mouseAngle = shotgunAngle.current;
      
      // Raycasting avec cône de vision de 45° (FOV) - OPTIMISÉ
      const fovAngle = Math.PI / 4; // 45 degrés
      const numFovRays = 15; // 15 rayons (optimisé, était 30)
      const maxRayDistance = 20; // Distance maximale de vision
      const raycastPoints: Array<{ x: number; z: number }> = [];
      
      for (let i = 0; i < numFovRays; i++) {
        // Angle du rayon dans le cône de vision
        const angleOffset = (i / (numFovRays - 1) - 0.5) * fovAngle;
        const rayAngle = mouseAngle + angleOffset;
        const rayDirX = Math.sin(rayAngle);
        const rayDirZ = Math.cos(rayAngle);
        
        let rayX = playerRef.current.position.x;
        let rayZ = playerRef.current.position.z;
        let distance = 0;
        const maxDist = maxRayDistance; // Distance maximale du rayon
        
        // Avancer par pas de 0.3 (optimisé, était 0.1)
        while (distance < maxDist) {
          rayX += rayDirX * 0.3;
          rayZ += rayDirZ * 0.3;
          distance += 0.3;
          
          // Vérifier collision avec murs
          let hitWall = false;
          for (const wall of walls) {
            const halfWidth = wall.width / 2;
            const halfDepth = wall.depth / 2;
            
            const wallDx = Math.abs(rayX - wall.x) - halfWidth;
            const wallDz = Math.abs(rayZ - wall.z) - halfDepth;
            
            if (wallDx < 0 && wallDz < 0) {
              hitWall = true;
              break;
            }
          }
          
          if (hitWall) {
            break;
          }
        }
        
        raycastPoints.push({ x: rayX, z: rayZ });
      }
      
      // Calculer le rayon du cercle de vision (distance au mur le plus proche)
      let circleRadius = 100;
      const numCircleRays = 360;
      
      for (let i = 0; i < numCircleRays; i++) {
        const angle = (i / numCircleRays) * Math.PI * 2;
        const rayDirX = Math.cos(angle);
        const rayDirZ = Math.sin(angle);
        
        let rayX = playerRef.current.position.x;
        let rayZ = playerRef.current.position.z;
        let distance = 0;
        const maxDist = 100;
        
        // Raymarching dans cette direction jusqu'à toucher un mur
        while (distance < maxDist) {
          let minDist = Infinity;
          
          for (const wall of walls) {
            const halfWidth = wall.width / 2;
            const halfDepth = wall.depth / 2;
            
            const wallDx = Math.abs(rayX - wall.x) - halfWidth;
            const wallDz = Math.abs(rayZ - wall.z) - halfDepth;
            
            if (wallDx < 0 && wallDz < 0) {
              minDist = 0;
              break;
            }
            
            const dist = wallDx > 0 && wallDz > 0 
              ? Math.sqrt(wallDx * wallDx + wallDz * wallDz)
              : Math.max(wallDx, wallDz);
            
            minDist = Math.min(minDist, dist);
          }
          
          if (minDist <= 0.5) {
            // Ce rayon a touché un mur à cette distance
            circleRadius = Math.min(circleRadius, distance);
            break;
          }
          
          const step = Math.min(Math.max(minDist * 0.8, 0.2), 2);
          rayX += rayDirX * step;
          rayZ += rayDirZ * step;
          distance += step;
        }
      }
      
      // Partager les données de vision avec raycasting FOV
      const newVisionData = {
        playerX: playerRef.current.position.x,
        playerZ: playerRef.current.position.z,
        visibleRadius: Math.max(circleRadius, 5), // Minimum 5 unités
        walls: walls,
        raycastPoints: raycastPoints,
        mouseAngle: mouseAngle
      };
      setVisionData(newVisionData);
      setCurrentVisionData(newVisionData);
      
      // Envoyer la position au serveur multijoueur
      multiplayer?.sendMove(
        playerRef.current.position.x,
        playerRef.current.position.z,
        mouseAngle
      );
      
      // Orienter le fusil vers la souris (perpendiculaire au sol)
      if (shotgunRef.current) {
        shotgunRef.current.position.copy(playerRef.current.position);
        shotgunRef.current.position.y = 0.8;
        shotgunRef.current.rotation.y = shotgunAngle.current;
        shotgunRef.current.visible = currentWeapon === 'shotgun';
      }
      
      // Mettre à jour le pistolet
      if (pistolRef.current) {
        pistolRef.current.position.copy(playerRef.current.position);
        pistolRef.current.position.y = 0.8;
        pistolRef.current.rotation.y = shotgunAngle.current;
        pistolRef.current.visible = currentWeapon === 'pistol';
      }
    }
    
    // Mettre à jour le flash du canon
    if (muzzleFlashRef.current && playerRef.current) {
      muzzleFlashRef.current.intensity = muzzleFlash ? 5 : 0;
      const flashDist = currentWeapon === 'shotgun' ? 1.2 : 0.8;
      const flashX = playerRef.current.position.x + Math.sin(shotgunAngle.current) * flashDist;
      const flashZ = playerRef.current.position.z + Math.cos(shotgunAngle.current) * flashDist;
      muzzleFlashRef.current.position.set(flashX, 0.8, flashZ);
    }
  });
  
  // Obtenir le premier spawn de la map
  const spawns = getSpawns();
  const playerSpawn = spawns.length > 0 ? spawns[0] : { x: 0, z: 0 };
  
  return (
    <>
      <mesh ref={playerRef} position={[playerSpawn.x, 0.5, playerSpawn.z]}>
        <cylinderGeometry args={[0.5, 0.5, 1, 8]} />
        <meshStandardMaterial color="#ff6b6b" />
      </mesh>
      
      {/* Fusil à pompe */}
      <group ref={shotgunRef} visible={currentWeapon === 'shotgun'}>
        {/* Corps du fusil */}
        <mesh position={[0, 0, 0.6]} rotation={[0, -Math.PI / 2, 0]}>
          <boxGeometry args={[1, 0.15, 0.15]} />
          <meshStandardMaterial color="#2c2c2c" />
        </mesh>
        {/* Canon */}
        <mesh position={[0, 0, 1.2]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.08, 0.08, 0.6, 8]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
        {/* Crosse */}
        <mesh position={[0, -0.1, 0.1]} rotation={[0, -Math.PI / 2, 0]}>
          <boxGeometry args={[0.3, 0.25, 0.12]} />
          <meshStandardMaterial color="#4a3520" />
        </mesh>
      </group>
      
      {/* Pistolet */}
      <group ref={pistolRef} visible={currentWeapon === 'pistol'}>
        {/* Corps du pistolet */}
        <mesh position={[0, 0, 0.3]} rotation={[0, -Math.PI / 2, 0]}>
          <boxGeometry args={[0.4, 0.2, 0.12]} />
          <meshStandardMaterial color="#1a1a1a" />
        </mesh>
        {/* Canon */}
        <mesh position={[0, 0.05, 0.6]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.04, 0.04, 0.35, 8]} />
          <meshStandardMaterial color="#333333" />
        </mesh>
        {/* Poignée */}
        <mesh position={[0, -0.15, 0.15]} rotation={[0.3, -Math.PI / 2, 0]}>
          <boxGeometry args={[0.25, 0.2, 0.1]} />
          <meshStandardMaterial color="#2a2a2a" />
        </mesh>
        {/* Détail - glissière */}
        <mesh position={[0, 0.08, 0.35]} rotation={[0, -Math.PI / 2, 0]}>
          <boxGeometry args={[0.3, 0.06, 0.1]} />
          <meshStandardMaterial color="#444444" />
        </mesh>
      </group>
      
      {/* Projectiles */}
      {projectiles.map(p => {
        // Vérifier si le projectile est dans le FOV
        if (currentVisionData.raycastPoints.length === 0) return null;
        
        const dx = p.x - currentVisionData.playerX;
        const dz = p.z - currentVisionData.playerZ;
        const pointAngle = Math.atan2(dx, dz);
        const fovAngle = Math.PI / 4;
        
        let angleDiff = pointAngle - currentVisionData.mouseAngle;
        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
        
        if (Math.abs(angleDiff) > fovAngle / 2) return null;
        
        const numRays = currentVisionData.raycastPoints.length;
        const rayIndex = Math.floor(((angleDiff + fovAngle / 2) / fovAngle) * (numRays - 1));
        const clampedIndex = Math.max(0, Math.min(numRays - 1, rayIndex));
        
        const rayPoint = currentVisionData.raycastPoints[clampedIndex];
        const maxDistX = rayPoint.x - currentVisionData.playerX;
        const maxDistZ = rayPoint.z - currentVisionData.playerZ;
        const maxDist = Math.sqrt(maxDistX * maxDistX + maxDistZ * maxDistZ);
        
        const pointDist = Math.sqrt(dx * dx + dz * dz);
        
        if (pointDist > maxDist + 2) return null;
        
        return (
          <mesh key={p.id} position={[p.x, 0.5, p.z]}>
            <sphereGeometry args={[0.1, 8, 8]} />
            <meshStandardMaterial color="#ffff00" emissive="#ffaa00" emissiveIntensity={0.5} />
          </mesh>
        );
      })}
      
      {/* Molotovs en vol */}
      {molotovs.map(m => (
        <group key={m.id} position={[m.x, m.y, m.z]}>
          {/* Bouteille */}
          <mesh>
            <cylinderGeometry args={[0.1, 0.15, 0.4, 6]} />
            <meshBasicMaterial color="#2d5a27" transparent opacity={0.7} />
          </mesh>
          {/* Flamme du chiffon */}
          <pointLight position={[0, 0.3, 0]} intensity={2} distance={3} color="#ff6600" />
        </group>
      ))}
      
      {/* Zones de feu */}
      {fireZones.map(f => (
        <group key={f.id} position={[f.x, 0.1, f.z]}>
          {/* Lumière du feu */}
          <pointLight intensity={f.life * 2} distance={f.radius * 2} color="#ff4400" />
          {/* Cercle de feu au sol */}
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[f.radius, 16]} />
            <meshBasicMaterial 
              color="#ff4400" 
              transparent 
              opacity={0.7} 
            />
          </mesh>
        </group>
      ))}
      
      <spotLight
        ref={spotLightRef}
        position={[0, 1, 0]}
        angle={(settings.flashlightAngle * Math.PI) / 180}
        penumbra={0.05}
        distance={80}
        intensity={flashlightOn ? settings.flashlightIntensity : 0}
        color="#ffffff"
      />
      
      {/* Flash du canon */}
      <pointLight
        ref={muzzleFlashRef}
        position={[0, 0.8, 0]}
        intensity={0}
        distance={10}
        color="#ff9900"
      />
      
      <primitive object={targetRef.current} />
    </>
  );
}

function Camera({ target }: { target: React.RefObject<THREE.Mesh> }) {
  return null;
}

function ConcreteFloor({ visionData }: { visionData: VisionData }) {
  const floorRef = useRef<THREE.Mesh>(null);
  
  // Créer une texture de carreaux béton procédurale
  const createConcreteTexture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    
    // Couleur béton de base
    const baseColor = '#8B8B8B';
    const lineColor = '#6B6B6B';
    
    // Remplir le fond
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, 512, 512);
    
    // Ajouter des variations de texture
    for (let i = 0; i < 1000; i++) {
      const x = Math.random() * 512;
      const y = Math.random() * 512;
      const size = Math.random() * 2;
      const opacity = Math.random() * 0.1;
      ctx.fillStyle = `rgba(0, 0, 0, ${opacity})`;
      ctx.fillRect(x, y, size, size);
    }
    
    // Dessiner les lignes de carreaux (grille 64x64)
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    const tileSize = 8;
    
    for (let i = 0; i <= 64; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * tileSize);
      ctx.lineTo(512, i * tileSize);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.moveTo(i * tileSize, 0);
      ctx.lineTo(i * tileSize, 512);
      ctx.stroke();
    }
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.5625, 1.5625);
    
    return texture;
  };
  
  const texture = createConcreteTexture();
  
  return (
    <mesh ref={floorRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[140, 80]} />
      <meshStandardMaterial 
        map={texture}
        roughness={0.9}
      />
    </mesh>
  );
}

function Walls({ visionData }: { visionData: VisionData }) {
  const isInVision = (wallX: number, wallZ: number, wallWidth: number, wallDepth: number) => {
    if (visionData.raycastPoints.length === 0) return false;
    
    const fovAngle = Math.PI / 4; // 45 degrés
    const numRays = visionData.raycastPoints.length;
    
    // Vérifier si au moins un rayon touche ce mur
    for (let i = 0; i < numRays; i++) {
      const rayPoint = visionData.raycastPoints[i];
      
      // Vérifier si le rayon traverse ou se termine près du mur
      const halfWidth = wallWidth / 2;
      const halfDepth = wallDepth / 2;
      
      const minX = wallX - halfWidth;
      const maxX = wallX + halfWidth;
      const minZ = wallZ - halfDepth;
      const maxZ = wallZ + halfDepth;
      
      // Vérifier si le point du rayon est dans ou près du mur
      if (rayPoint.x >= minX - 1 && rayPoint.x <= maxX + 1 &&
          rayPoint.z >= minZ - 1 && rayPoint.z <= maxZ + 1) {
        return true;
      }
      
      // Vérifier si le rayon traverse le mur (entre joueur et point)
      const dx = rayPoint.x - visionData.playerX;
      const dz = rayPoint.z - visionData.playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist > 0.1) {
        const dirX = dx / dist;
        const dirZ = dz / dist;
        
        // Échantillonner le long du rayon
        const numSamples = Math.ceil(dist / 0.5);
        for (let j = 0; j <= numSamples; j++) {
          const t = (j / numSamples) * dist;
          const sampleX = visionData.playerX + dirX * t;
          const sampleZ = visionData.playerZ + dirZ * t;
          
          if (sampleX >= minX - 0.5 && sampleX <= maxX + 0.5 &&
              sampleZ >= minZ - 0.5 && sampleZ <= maxZ + 0.5) {
            return true;
          }
        }
      }
    }
    
    return false;
  };
  
  // Charger les murs depuis la map JSON
  const walls = getWallMeshes();
  
  // Distance de culling pour les murs
  const WALL_RENDER_DISTANCE = 30;
  
  // Filtrer les murs proches du joueur
  const nearbyWalls = useMemo(() => {
    return walls.filter(wall => {
      const dx = wall.position[0] - visionData.playerX;
      const dz = wall.position[2] - visionData.playerZ;
      return Math.sqrt(dx * dx + dz * dz) < WALL_RENDER_DISTANCE;
    });
  }, [Math.floor(visionData.playerX / 5), Math.floor(visionData.playerZ / 5)]);
  
  return (
    <>
      {nearbyWalls.map((wall, index) => {
        const visible = isInVision(wall.position[0], wall.position[2], wall.args[0], wall.args[2]);
        return visible ? (
          <mesh key={index} position={wall.position}>
            <boxGeometry args={wall.args} />
            <meshStandardMaterial color={wall.color} />
          </mesh>
        ) : null;
      })}
    </>
  );
}

// Composant pour les meubles
function Furniture({ visionData }: { visionData: VisionData }) {
  const furniture = getFurniture();
  
  // Fonction pour vérifier si un meuble est dans le champ de vision
  const isInVision = (itemX: number, itemZ: number, itemWidth: number, itemDepth: number) => {
    if (visionData.raycastPoints.length === 0) return false;
    
    const numRays = visionData.raycastPoints.length;
    
    // Vérifier si au moins un rayon touche ce meuble
    for (let i = 0; i < numRays; i++) {
      const rayPoint = visionData.raycastPoints[i];
      
      const halfWidth = itemWidth / 2;
      const halfDepth = itemDepth / 2;
      
      const minX = itemX - halfWidth;
      const maxX = itemX + halfWidth;
      const minZ = itemZ - halfDepth;
      const maxZ = itemZ + halfDepth;
      
      // Vérifier si le point du rayon est dans ou près du meuble
      if (rayPoint.x >= minX - 1 && rayPoint.x <= maxX + 1 &&
          rayPoint.z >= minZ - 1 && rayPoint.z <= maxZ + 1) {
        return true;
      }
      
      // Vérifier si le rayon traverse le meuble (entre joueur et point)
      const dx = rayPoint.x - visionData.playerX;
      const dz = rayPoint.z - visionData.playerZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist > 0.1) {
        const dirX = dx / dist;
        const dirZ = dz / dist;
        
        // Échantillonner le long du rayon
        const numSamples = Math.ceil(dist / 0.5);
        for (let j = 0; j <= numSamples; j++) {
          const t = (j / numSamples) * dist;
          const sampleX = visionData.playerX + dirX * t;
          const sampleZ = visionData.playerZ + dirZ * t;
          
          if (sampleX >= minX - 0.5 && sampleX <= maxX + 0.5 &&
              sampleZ >= minZ - 0.5 && sampleZ <= maxZ + 0.5) {
            return true;
          }
        }
      }
    }
    
    return false;
  };
  
  const getColor = (type: string) => {
    switch (type) {
      case 'table': return '#8B4513';
      case 'bureau': return '#654321';
      case 'chaise': return '#A0522D';
      case 'armoire': return '#4A3728';
      case 'caisse': return '#DEB887';
      case 'poubelle': return '#696969';
      case 'plante': return '#228B22';
      case 'lampe': return '#FFD700';
      default: return '#808080';
    }
  };
  
  const getHeight = (type: string) => {
    switch (type) {
      case 'table': return 0.8;
      case 'bureau': return 0.9;
      case 'chaise': return 0.5;
      case 'armoire': return 2;
      case 'caisse': return 0.6;
      case 'poubelle': return 0.5;
      case 'plante': return 1;
      case 'lampe': return 1.5;
      default: return 0.5;
    }
  };
  
  // Filtrer par distance (frustum culling manuel) - OPTIMISATION
  const MAX_RENDER_DISTANCE = 25;
  const visibleFurniture = useMemo(() => {
    return furniture.filter(item => {
      const dx = item.x - visionData.playerX;
      const dz = item.z - visionData.playerZ;
      return Math.sqrt(dx * dx + dz * dz) < MAX_RENDER_DISTANCE;
    });
  }, [visionData.playerX, visionData.playerZ, furniture]);
  
  return (
    <>
      {visibleFurniture.map((item, index) => {
        const visible = isInVision(item.x, item.z, item.width, item.depth);
        return visible ? (
          <mesh 
            key={index} 
            position={[item.x, getHeight(item.type) / 2, item.z]}
          >
            <boxGeometry args={[item.width, getHeight(item.type), item.depth]} />
            <meshLambertMaterial color={getColor(item.type)} />
          </mesh>
        ) : null;
      })}
    </>
  );
}

// Composant pour les lumières de la map - OPTIMISÉ
function MapLights({ visionData }: { visionData: VisionData }) {
  const allLights = getLights();
  const flickerRef = useRef<{ [key: number]: number }>({});
  const lastFlickerUpdate = useRef(0);
  
  // OPTIMISATION: Limiter à 8 lumières les plus proches
  const MAX_LIGHTS = 8;
  const LIGHT_RENDER_DISTANCE = 25;
  
  const lights = useMemo(() => {
    return allLights
      .map((light, index) => ({ ...light, originalIndex: index }))
      .filter(light => {
        const dx = light.x - visionData.playerX;
        const dz = light.z - visionData.playerZ;
        return Math.sqrt(dx * dx + dz * dz) < LIGHT_RENDER_DISTANCE;
      })
      .sort((a, b) => {
        const distA = Math.sqrt((a.x - visionData.playerX) ** 2 + (a.z - visionData.playerZ) ** 2);
        const distB = Math.sqrt((b.x - visionData.playerX) ** 2 + (b.z - visionData.playerZ) ** 2);
        return distA - distB;
      })
      .slice(0, MAX_LIGHTS);
  }, [visionData.playerX, visionData.playerZ, allLights]);
  
  // Fonction simplifiée pour vérifier si une lumière est dans le champ de vision
  const isInVision = (lightX: number, lightZ: number, lightRadius: number) => {
    if (visionData.raycastPoints.length === 0) return false;
    
    // OPTIMISATION: Vérifier seulement quelques rayons
    const step = Math.max(1, Math.floor(visionData.raycastPoints.length / 5));
    for (let i = 0; i < visionData.raycastPoints.length; i += step) {
      const rayPoint = visionData.raycastPoints[i];
      
      const dx = rayPoint.x - lightX;
      const dz = rayPoint.z - lightZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      if (dist <= lightRadius + 3) {
        return true;
      }
    }
    
    return false;
  };
  
  useFrame((state) => {
    // OPTIMISATION: Throttle les updates de scintillement
    if (state.clock.elapsedTime - lastFlickerUpdate.current > 0.1) {
      lights.forEach((light) => {
        if (light.flicker) {
          flickerRef.current[light.originalIndex] = 0.7 + Math.sin(state.clock.elapsedTime * 10 + light.originalIndex) * 0.3 + Math.random() * 0.2;
        }
      });
      lastFlickerUpdate.current = state.clock.elapsedTime;
    }
  });
  
  return (
    <>
      {lights.map((light) => {
        const visible = isInVision(light.x, light.z, light.radius);
        if (!visible) return null;
        
        const colorHex = `rgb(${light.color[0]}, ${light.color[1]}, ${light.color[2]})`;
        const flickerMultiplier = light.flicker ? (flickerRef.current[light.originalIndex] || 1) : 1;
        const baseIntensity = light.intensity * 5 * flickerMultiplier;
        
        // Hauteur selon le type de lumière
        const getHeight = () => {
          switch (light.type) {
            case 'lampadaire': return 4;
            case 'neon': return 3.5;
            case 'spot': return 3;
            case 'bougie': return 1;
            case 'feu': return 0.5;
            case 'ecran': return 1.2;
            case 'led_bleu':
            case 'led_rouge':
            case 'led_vert': return 2;
            default: return 2.5;
          }
        };
        
        // Taille de la source lumineuse
        const getSize = () => {
          switch (light.type) {
            case 'lampadaire': return 0.3;
            case 'neon': return 0.5;
            case 'spot': return 0.2;
            case 'bougie': return 0.1;
            case 'feu': return 0.4;
            case 'ecran': return 0.3;
            case 'led_bleu':
            case 'led_rouge':
            case 'led_vert': return 0.15;
            default: return 0.2;
          }
        };
        
        const height = getHeight();
        const size = getSize();
        
        return (
          <group key={light.originalIndex}>
            {/* Source lumineuse visible (sphère émissive) */}
            <mesh position={[light.x, height, light.z]}>
              <sphereGeometry args={[size, 8, 8]} />
              <meshBasicMaterial 
                color={colorHex} 
                transparent 
                opacity={0.9}
              />
            </mesh>
            
            {/* Halo autour de la lumière */}
            <mesh position={[light.x, height, light.z]}>
              <sphereGeometry args={[size * 2, 8, 8]} />
              <meshBasicMaterial 
                color={colorHex} 
                transparent 
                opacity={0.2 * flickerMultiplier}
              />
            </mesh>
            
            {/* Point light pour éclairer les environs */}
            <pointLight
              position={[light.x, height, light.z]}
              color={colorHex}
              intensity={baseIntensity}
              distance={light.radius * 3}
              decay={2}
            />
            
            {/* Lumière au sol pour les feux et bougies */}
            {(light.type === 'feu' || light.type === 'bougie') && (
              <pointLight
                position={[light.x, 0.2, light.z]}
                color={colorHex}
                intensity={baseIntensity * 0.5}
                distance={light.radius * 2}
                decay={2}
              />
            )}
          </group>
        );
      })}
    </>
  );
}

// Composant pour le ring Battle Royale
function BattleRoyaleRing({ 
  ringRadius, 
  setRingRadius, 
  ringCenter, 
  gameStartTime, 
  ringDuration, 
  initialRadius, 
  finalRadius,
  setPlayerHealth,
  visionData
}: { 
  ringRadius: number;
  setRingRadius: (radius: number) => void;
  ringCenter: { x: number; z: number };
  gameStartTime: number;
  ringDuration: number;
  initialRadius: number;
  finalRadius: number;
  setPlayerHealth: (fn: (prev: number) => number) => void;
  visionData: VisionData;
}) {
  const ringRef = useRef<THREE.Mesh>(null);
  const damageTickRef = useRef(0);
  
  useFrame((state, delta) => {
    // Calculer le temps écoulé
    const elapsed = Date.now() - gameStartTime;
    const progress = Math.min(elapsed / ringDuration, 1);
    
    // Interpolation linéaire du rayon
    const newRadius = initialRadius - (initialRadius - finalRadius) * progress;
    setRingRadius(newRadius);
    
    // Vérifier si le joueur est hors de la zone
    const playerX = visionData.playerX;
    const playerZ = visionData.playerZ;
    const distToCenter = Math.sqrt(
      (playerX - ringCenter.x) ** 2 + 
      (playerZ - ringCenter.z) ** 2
    );
    
    // Si le joueur est hors du ring, infliger des dégâts
    if (distToCenter > newRadius) {
      damageTickRef.current += delta;
      // 10 dégâts par seconde hors de la zone
      if (damageTickRef.current >= 0.5) {
        setPlayerHealth(h => Math.max(0, h - 5));
        damageTickRef.current = 0;
      }
    } else {
      damageTickRef.current = 0;
    }
    
    // Exposer le ringRadius pour l'UI
    // @ts-ignore
    window.__ringRadius = newRadius;
  });
  
  // Créer la géométrie du ring (anneau)
  const ringGeometry = useMemo(() => {
    const outerRadius = 100; // Rayon externe fixe (bord de la map)
    const segments = 64;
    
    const shape = new THREE.Shape();
    // Cercle externe
    shape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
    
    // Trou interne (zone safe)
    const hole = new THREE.Path();
    hole.absarc(0, 0, ringRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
    
    return new THREE.ShapeGeometry(shape, segments);
  }, [ringRadius]);
  
  // Créer le cercle de bordure (ligne de la zone)
  const borderGeometry = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const segments = 64;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(
        ringCenter.x + Math.cos(angle) * ringRadius,
        0.1,
        ringCenter.z + Math.sin(angle) * ringRadius
      ));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [ringRadius, ringCenter]);
  
  return (
    <group>
      {/* Zone dangereuse (rouge semi-transparent) */}
      <mesh 
        ref={ringRef}
        rotation={[-Math.PI / 2, 0, 0]} 
        position={[ringCenter.x, 0.05, ringCenter.z]}
      >
        <primitive object={ringGeometry} />
        <meshBasicMaterial 
          color="#ff0000" 
          transparent 
          opacity={0.3}
          side={THREE.DoubleSide}
        />
      </mesh>
      
      {/* Bordure du ring (ligne bleue électrique) */}
      <line position={[0, 0, 0]}>
        <primitive object={borderGeometry} />
        <lineBasicMaterial color="#00aaff" linewidth={3} />
      </line>
      
      {/* Effet de mur vertical sur la bordure */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[ringCenter.x, 2, ringCenter.z]}>
        <ringGeometry args={[ringRadius - 0.1, ringRadius + 0.1, 64]} />
        <meshBasicMaterial 
          color="#00aaff" 
          transparent 
          opacity={0.5}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

function Scene({ settings, showRaycast, setPlayerHealth, setPlayerStamina, multiplayer, remotePlayers, remoteProjectiles, remoteFireZones }: { 
  settings: GameSettings; 
  showRaycast: boolean;
  setPlayerHealth: (fn: (prev: number) => number) => void;
  setPlayerStamina: (fn: (prev: number) => number) => void;
  multiplayer?: MultiplayerCallbacks;
  remotePlayers: Map<string, RemotePlayer>;
  remoteProjectiles: RemoteProjectile[];
  remoteFireZones: RemoteFireZone[];
}) {
  const [visionData, setVisionData] = useState<VisionData>({ 
    playerX: 0, 
    playerZ: 0, 
    visibleRadius: 50,
    walls: [],
    raycastPoints: [],
    mouseAngle: 0
  });
  
  // État du ring Battle Royale
  const [ringRadius, setRingRadius] = useState(80); // Rayon initial (couvre toute la map)
  const [ringCenter] = useState({ x: 0, z: 0 }); // Centre de la map
  const [gameStartTime] = useState(Date.now());
  const ringDuration = 7 * 60 * 1000; // 7 minutes en millisecondes
  const initialRadius = 80;
  const finalRadius = 5; // Rayon final très petit
  
  return (
    <>
      <ambientLight intensity={settings.ambientLight} />
      <directionalLight position={[100, 100, 50]} intensity={settings.ambientLight * 2} />
      
      <ConcreteFloor visionData={visionData} />
      <Walls visionData={visionData} />
      <Furniture visionData={visionData} />
      <MapLights visionData={visionData} />
      <BattleRoyaleRing 
        ringRadius={ringRadius} 
        setRingRadius={setRingRadius}
        ringCenter={ringCenter}
        gameStartTime={gameStartTime}
        ringDuration={ringDuration}
        initialRadius={initialRadius}
        finalRadius={finalRadius}
        setPlayerHealth={setPlayerHealth}
        visionData={visionData}
      />
      <Player settings={settings} setVisionData={setVisionData} showRaycast={showRaycast} setPlayerStamina={setPlayerStamina} setPlayerHealth={setPlayerHealth} multiplayer={multiplayer} />
      
      {/* Joueurs distants (multijoueur) */}
      <RemotePlayers players={remotePlayers} visionData={visionData} />
      <RemoteProjectiles projectiles={remoteProjectiles} />
      <RemoteFireZones fireZones={remoteFireZones} />
      
      <Bot visionData={visionData} showRaycast={showRaycast} />
      <GreenFOVMask visionData={visionData} />
      <BlackFOVMask visionData={visionData} />
      <PlayerCamera />
    </>
  );
}

function PlayerCamera() {
  useFrame(({ camera, scene }) => {
    // Trouver le joueur dans la scène
    const player = scene.children.find(
      child => child instanceof THREE.Mesh && (child as any).geometry instanceof THREE.CylinderGeometry
    ) as THREE.Mesh | undefined;
    
    if (player) {
      const targetPos = player.position;
      camera.position.x = targetPos.x;
      camera.position.y = 30;
      camera.position.z = targetPos.z;
      camera.lookAt(targetPos.x, targetPos.y, targetPos.z);
    }
  });
  
  return null;
}

function VisionCircle({ visionData }: { visionData: VisionData }) {
  return null;
}

function PlayerLightCone({ playerRef, targetRef, flashlightOn, intensity, angle, showRaycast }: { 
  playerRef: React.RefObject<THREE.Mesh>;
  targetRef: React.RefObject<THREE.Object3D>;
  flashlightOn: boolean;
  intensity: number;
  angle: number;
  showRaycast: boolean;
}) {
  const coneRef = useRef<THREE.Line>(null);
  
  useFrame(() => {
    if (coneRef.current && playerRef.current && targetRef.current && flashlightOn) {
      const playerPos = playerRef.current.position;
      const targetPos = targetRef.current.position;
      
      // Calculer la direction
      const dirX = targetPos.x - playerPos.x;
      const dirZ = targetPos.z - playerPos.z;
      const distance = Math.sqrt(dirX * dirX + dirZ * dirZ);
      
      // Calculer les deux côtés du cône
      const angleRad = angle;
      const points: THREE.Vector3[] = [];
      
      // Point de départ (joueur)
      points.push(new THREE.Vector3(playerPos.x, 0.2, playerPos.z));
      
      // Tracer le contour du cône
      const baseAngle = Math.atan2(dirX, dirZ);
      const leftAngle = baseAngle - angleRad / 2;
      const rightAngle = baseAngle + angleRad / 2;
      
      // Côté gauche
      const leftDirX = Math.sin(leftAngle);
      const leftDirZ = Math.cos(leftAngle);
      const leftEndX = playerPos.x + leftDirX * Math.min(distance, 80);
      const leftEndZ = playerPos.z + leftDirZ * Math.min(distance, 80);
      points.push(new THREE.Vector3(leftEndX, 0.2, leftEndZ));
      
      // Arc du bout du cône
      const numArcPoints = 20;
      for (let i = 0; i <= numArcPoints; i++) {
        const t = i / numArcPoints;
        const currentAngle = leftAngle + angleRad * t;
        const arcDirX = Math.sin(currentAngle);
        const arcDirZ = Math.cos(currentAngle);
        const arcX = playerPos.x + arcDirX * Math.min(distance, 80);
        const arcZ = playerPos.z + arcDirZ * Math.min(distance, 80);
        points.push(new THREE.Vector3(arcX, 0.2, arcZ));
      }
      
      // Retour au point de départ
      points.push(new THREE.Vector3(playerPos.x, 0.2, playerPos.z));
      
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      coneRef.current.geometry.dispose();
      coneRef.current.geometry = geometry;
    }
  });
  
  return (
    <line ref={coneRef}>
      <bufferGeometry />
      <lineBasicMaterial color="#0000ff" linewidth={3} transparent opacity={showRaycast && flashlightOn ? 0.8 : 0} />
    </line>
  );
}

function BotLightCone({ botFlashlightOn, showRaycast }: { botFlashlightOn: boolean; showRaycast: boolean }) {
  const coneRef = useRef<THREE.Line>(null);
  
  useFrame(() => {
    if (coneRef.current && botFlashlightOn) {
      const botX = 30;
      const botZ = 30;
      const dirX = 0;
      const dirZ = 1; // Direction sud
      const distance = 80;
      const angleRad = Math.PI / 6; // 30 degrés
      
      const points: THREE.Vector3[] = [];
      
      // Point de départ (bot)
      points.push(new THREE.Vector3(botX, 0.2, botZ));
      
      // Tracer le contour du cône
      const baseAngle = Math.atan2(dirX, dirZ);
      const leftAngle = baseAngle - angleRad / 2;
      const leftDirX = Math.sin(leftAngle);
      const leftDirZ = Math.cos(leftAngle);
      const leftEndX = botX + leftDirX * distance;
      const leftEndZ = botZ + leftDirZ * distance;
      points.push(new THREE.Vector3(leftEndX, 0.2, leftEndZ));
      
      // Arc du bout du cône
      const numArcPoints = 20;
      for (let i = 0; i <= numArcPoints; i++) {
        const t = i / numArcPoints;
        const currentAngle = leftAngle + angleRad * t;
        const arcDirX = Math.sin(currentAngle);
        const arcDirZ = Math.cos(currentAngle);
        const arcX = botX + arcDirX * distance;
        const arcZ = botZ + arcDirZ * distance;
        points.push(new THREE.Vector3(arcX, 0.2, arcZ));
      }
      
      // Retour au point de départ
      points.push(new THREE.Vector3(botX, 0.2, botZ));
      
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      coneRef.current.geometry.dispose();
      coneRef.current.geometry = geometry;
    }
  });
  
  return (
    <line ref={coneRef}>
      <bufferGeometry />
      <lineBasicMaterial color="#ff0000" linewidth={3} transparent opacity={showRaycast && botFlashlightOn ? 0.8 : 0} />
    </line>
  );
}

function BotLightMask({ visionData, botFlashlightOn }: { visionData: VisionData; botFlashlightOn: boolean }) {
  const maskRef = useRef<THREE.Mesh>(null);
  
  const vertexShader = `
    varying vec3 vWorldPos;
    
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;
  
  const fragmentShader = `
    uniform vec3 playerPos;
    uniform float mouseAngle;
    uniform float fovAngle;
    uniform vec3 raycastPoints[30];
    uniform int numRays;
    uniform vec3 botPos;
    uniform float botLightAngle;
    uniform bool botLightOn;
    
    varying vec3 vWorldPos;
    
    #define PI 3.14159265359
    
    void main() {
      if (!botLightOn) {
        discard;
      }
      
      if (numRays == 0) {
        discard;
      }
      
      vec2 posXZ = vWorldPos.xz;
      vec2 botXZ = botPos.xz;
      vec2 playerXZ = playerPos.xz;
      
      // Vérifier si dans le cône de lumière du bot (zone rouge)
      vec2 diffBot = posXZ - botXZ;
      float distToBot = length(diffBot);
      
      if (distToBot > 80.0) {
        discard;
      }
      
      float angleToBot = atan(diffBot.x, diffBot.y);
      float botAngleDiff = angleToBot;
      if (botAngleDiff > PI) botAngleDiff -= 2.0 * PI;
      if (botAngleDiff < -PI) botAngleDiff += 2.0 * PI;
      
      if (abs(botAngleDiff) > botLightAngle / 2.0) {
        discard;
      }
      
      // On est dans la zone rouge
      // Maintenant vérifier si AUSSI dans le FOV du joueur (zone bleue)
      vec2 diff = posXZ - playerXZ;
      float pointAngle = atan(diff.x, diff.y);
      
      float angleDiff = pointAngle - mouseAngle;
      if (angleDiff > PI) angleDiff -= 2.0 * PI;
      if (angleDiff < -PI) angleDiff += 2.0 * PI;
      
      // Si dans l'angle du FOV
      if (abs(angleDiff) <= fovAngle / 2.0) {
        int rayIndex = int(((angleDiff + fovAngle / 2.0) / fovAngle) * float(numRays - 1));
        rayIndex = clamp(rayIndex, 0, numRays - 1);
        
        vec3 rayPoint = raycastPoints[rayIndex];
        vec2 rayXZ = rayPoint.xz;
        
        float maxDist = length(rayXZ - playerXZ);
        float pointDist = length(diff);
        
        if (pointDist <= maxDist + 2.0) {
          // Dans FOV ET dans zone rouge -> intersection, on retire le masque
          discard;
        }
      }
      
      // Seulement dans zone rouge, PAS dans FOV -> masque noir
      gl_FragColor = vec4(0.0, 0.0, 0.0, 0.9);
    }
  `;
  
  useFrame(() => {
    if (maskRef.current && (maskRef.current.material as THREE.ShaderMaterial).uniforms) {
      const uniforms = (maskRef.current.material as THREE.ShaderMaterial).uniforms;
      uniforms.playerPos.value.set(visionData.playerX, 0, visionData.playerZ);
      uniforms.mouseAngle.value = visionData.mouseAngle;
      
      for (let i = 0; i < visionData.raycastPoints.length && i < 30; i++) {
        uniforms.raycastPoints.value[i].set(
          visionData.raycastPoints[i].x,
          0,
          visionData.raycastPoints[i].z
        );
      }
      uniforms.numRays.value = visionData.raycastPoints.length;
      uniforms.botLightOn.value = botFlashlightOn;
    }
  });
  
  return (
    <mesh ref={maskRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.5, 0]} renderOrder={1000}>
      <planeGeometry args={[100, 100, 200, 200]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent={true}
        depthWrite={false}
        depthTest={true}
        side={THREE.DoubleSide}
        uniforms={{
          playerPos: { value: new THREE.Vector3(0, 0, 0) },
          mouseAngle: { value: 0 },
          fovAngle: { value: Math.PI / 4 },
          raycastPoints: { value: Array(30).fill(null).map(() => new THREE.Vector3(0, 0, 0)) },
          numRays: { value: 0 },
          botPos: { value: new THREE.Vector3(30, 0, 30) },
          botLightAngle: { value: Math.PI / 6 },
          botLightOn: { value: false }
        }}
      />
    </mesh>
  );
}

function EnemyRedMask({ visionData }: { visionData: VisionData }) {
  const maskRef = useRef<THREE.Mesh>(null);
  
  const vertexShader = `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;
  
  const fragmentShader = `
    uniform vec3 botPos;
    uniform float botLightAngle;
    uniform float maxDist;
    uniform vec3 playerPos;
    uniform float mouseAngle;
    uniform float fovAngle;
    uniform vec3 raycastPoints[30];
    uniform int numRays;
    varying vec3 vWorldPos;
    #define PI 3.14159265359
    void main() {
      vec2 posXZ = vWorldPos.xz;
      vec2 botXZ = botPos.xz;
      vec2 diff = posXZ - botXZ;
      float dist = length(diff);
      if (dist > maxDist) { discard; }
      float angleTo = atan(diff.x, diff.y);
      float baseAngle = 0.0; // bot regarde +Z
      float a = angleTo - baseAngle;
      if (a > PI) a -= 2.0 * PI;
      if (a < -PI) a += 2.0 * PI;
      if (abs(a) > botLightAngle * 0.5) { discard; }
      
      // Check if in player FOV using raycast points
      if (numRays == 0) {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 0.18);
        return;
      }
      
      vec2 playerXZ = playerPos.xz;
      vec2 diffPlayer = posXZ - playerXZ;
      bool inPlayerCone = false;
      
      float pointAngle = atan(diffPlayer.x, diffPlayer.y);
      float angleDiff = pointAngle - mouseAngle;
      if (angleDiff > PI) angleDiff -= 2.0 * PI;
      if (angleDiff < -PI) angleDiff += 2.0 * PI;
      
      if (abs(angleDiff) <= fovAngle * 0.5) {
        int rayIndex = int(floor(((angleDiff + fovAngle * 0.5) / fovAngle) * float(numRays - 1)));
        rayIndex = clamp(rayIndex, 0, numRays - 1);
        vec2 rayXZ = raycastPoints[rayIndex].xz;
        float maxDistPlayer = length(rayXZ - playerXZ);
        float pointDist = length(diffPlayer);
        if (pointDist <= maxDistPlayer + 2.0) {
          inPlayerCone = true;
        }
      }
      
      if (inPlayerCone) {
        gl_FragColor = vec4(1.0, 0.4, 0.8, 0.35); // Rose/magenta
      } else {
        gl_FragColor = vec4(1.0, 0.0, 0.0, 0.18); // Rouge
      }
    }
  `;
  
  useFrame(() => {
    if (maskRef.current && (maskRef.current.material as THREE.ShaderMaterial).uniforms) {
      const uniforms = (maskRef.current.material as THREE.ShaderMaterial).uniforms;
      uniforms.playerPos.value.set(visionData.playerX, 0, visionData.playerZ);
      uniforms.mouseAngle.value = visionData.mouseAngle;
      for (let i = 0; i < visionData.raycastPoints.length && i < 30; i++) {
        uniforms.raycastPoints.value[i].set(
          visionData.raycastPoints[i].x,
          0,
          visionData.raycastPoints[i].z
        );
      }
      uniforms.numRays.value = visionData.raycastPoints.length;
    }
  });
  
  return (
    <mesh ref={maskRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.505, 0]} renderOrder={1020}>
      <planeGeometry args={[100, 100, 100, 100]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent={true}
        depthWrite={false}
        depthTest={true}
        side={THREE.DoubleSide}
        uniforms={{
          botPos: { value: new THREE.Vector3(30, 0, 30) },
          botLightAngle: { value: Math.PI / 6 },
          maxDist: { value: 80 },
          playerPos: { value: new THREE.Vector3(0, 0, 0) },
          mouseAngle: { value: 0 },
          fovAngle: { value: Math.PI / 4 },
          raycastPoints: { value: Array(30).fill(null).map(() => new THREE.Vector3(0, 0, 0)) },
          numRays: { value: 0 }
        }}
      />
    </mesh>
  );
}

function GreenFOVMask({ visionData }: { visionData: VisionData }) {
  const maskRef = useRef<THREE.Mesh>(null);
  
  const vertexShader = `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;
  
  const fragmentShader = `
    uniform vec3 playerPos;
    uniform float mouseAngle;
    uniform float fovAngle;
    uniform vec3 raycastPoints[30];
    uniform int numRays;
    varying vec3 vWorldPos;
    #define PI 3.14159265359
    void main() {
      if (numRays == 0) { discard; }
      vec2 posXZ = vWorldPos.xz;
      vec2 playerXZ = playerPos.xz;
      vec2 diff = posXZ - playerXZ;
      float pointAngle = atan(diff.x, diff.y);
      float angleDiff = pointAngle - mouseAngle;
      if (angleDiff > PI) angleDiff -= 2.0 * PI;
      if (angleDiff < -PI) angleDiff += 2.0 * PI;
      if (abs(angleDiff) > fovAngle * 0.5) { discard; }
      int rayIndex = int(floor(((angleDiff + fovAngle * 0.5) / fovAngle) * float(numRays - 1)));
      rayIndex = clamp(rayIndex, 0, numRays - 1);
      vec2 rayXZ = raycastPoints[rayIndex].xz;
      float maxDist = length(rayXZ - playerXZ);
      float pointDist = length(diff);
      if (pointDist <= maxDist + 2.0) {
        // Check if also in bot cone (red zone)
        vec2 botXZ = vec2(30.0, 30.0);
        vec2 diffBot = posXZ - botXZ;
        float distToBot = length(diffBot);
        float botAngle = 0.0;
        float botFOV = 0.523598776; // PI/6
        bool inBotCone = false;
        if (distToBot <= 80.0) {
          float angleToBot = atan(diffBot.x, diffBot.y);
          float botAngleDiff = angleToBot - botAngle;
          if (botAngleDiff > PI) botAngleDiff -= 2.0 * PI;
          if (botAngleDiff < -PI) botAngleDiff += 2.0 * PI;
          if (abs(botAngleDiff) <= botFOV / 2.0) {
            inBotCone = true;
          }
        }
        if (inBotCone) {
          gl_FragColor = vec4(1.0, 0.4, 0.8, 1.0); // Rose/magenta
        } else {
          gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); // Vert
        }
      } else {
        discard;
      }
    }
  `;
  
  useFrame(() => {
    if (maskRef.current && (maskRef.current.material as THREE.ShaderMaterial).uniforms) {
      const uniforms = (maskRef.current.material as THREE.ShaderMaterial).uniforms;
      uniforms.playerPos.value.set(visionData.playerX, 0, visionData.playerZ);
      uniforms.mouseAngle.value = visionData.mouseAngle;
      for (let i = 0; i < visionData.raycastPoints.length && i < 30; i++) {
        uniforms.raycastPoints.value[i].set(
          visionData.raycastPoints[i].x,
          0,
          visionData.raycastPoints[i].z
        );
      }
      uniforms.numRays.value = visionData.raycastPoints.length;
    }
  });
  
  return (
    <mesh ref={maskRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.6, 0]} renderOrder={1200}>
      <planeGeometry args={[100, 100, 200, 200]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent={true}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
        blending={THREE.NormalBlending}
        uniforms={{
          playerPos: { value: new THREE.Vector3(0, 0, 0) },
          mouseAngle: { value: 0 },
          fovAngle: { value: Math.PI / 3 },
          raycastPoints: { value: Array(30).fill(null).map(() => new THREE.Vector3(0, 0, 0)) },
          numRays: { value: 0 }
        }}
      />
    </mesh>
  );
}

function BlackFOVMask({ visionData }: { visionData: VisionData }) {
  const maskRef = useRef<THREE.Mesh>(null);
  
  const vertexShader = `
    varying vec3 vWorldPos;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPos = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `;
  
  const fragmentShader = `
    uniform vec3 playerPos;
    uniform float mouseAngle;
    uniform float fovAngle;
    uniform vec3 raycastPoints[30];
    uniform int numRays;
    varying vec3 vWorldPos;
    #define PI 3.14159265359
    void main() {
      if (numRays == 0) { discard; }
      vec2 posXZ = vWorldPos.xz;
      vec2 playerXZ = playerPos.xz;
      vec2 diff = posXZ - playerXZ;
      float pointAngle = atan(diff.x, diff.y);
      float angleDiff = pointAngle - mouseAngle;
      if (angleDiff > PI) angleDiff -= 2.0 * PI;
      if (angleDiff < -PI) angleDiff += 2.0 * PI;
      if (abs(angleDiff) > fovAngle * 0.5) { discard; }
      int rayIndex = int(floor(((angleDiff + fovAngle * 0.5) / fovAngle) * float(numRays - 1)));
      rayIndex = clamp(rayIndex, 0, numRays - 1);
      vec2 rayXZ = raycastPoints[rayIndex].xz;
      float maxDist = length(rayXZ - playerXZ);
      float pointDist = length(diff);
      if (pointDist <= maxDist + 2.0) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.5);
      } else {
        discard;
      }
    }
  `;
  
  useFrame(() => {
    if (maskRef.current && (maskRef.current.material as THREE.ShaderMaterial).uniforms) {
      const uniforms = (maskRef.current.material as THREE.ShaderMaterial).uniforms;
      uniforms.playerPos.value.set(visionData.playerX, 0, visionData.playerZ);
      uniforms.mouseAngle.value = visionData.mouseAngle;
      for (let i = 0; i < visionData.raycastPoints.length && i < 30; i++) {
        uniforms.raycastPoints.value[i].set(
          visionData.raycastPoints[i].x,
          0,
          visionData.raycastPoints[i].z
        );
      }
      uniforms.numRays.value = visionData.raycastPoints.length;
    }
  });
  
  return (
    <mesh ref={maskRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.52, 0]} renderOrder={1110}>
      <planeGeometry args={[100, 100, 200, 200]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent={true}
        depthWrite={false}
        depthTest={false}
        side={THREE.DoubleSide}
        uniforms={{
          playerPos: { value: new THREE.Vector3(0, 0, 0) },
          mouseAngle: { value: 0 },
          fovAngle: { value: Math.PI / 3 },
          raycastPoints: { value: Array(30).fill(null).map(() => new THREE.Vector3(0, 0, 0)) },
          numRays: { value: 0 }
        }}
      />
    </mesh>
  );
}

function FovShape({ visionData }: { visionData: VisionData }) {
  const shapeRef = useRef<THREE.Line>(null);
  
  useEffect(() => {
    if (!shapeRef.current || visionData.raycastPoints.length === 0) return;
    
    const points: THREE.Vector3[] = [];
    
    // Ajouter le point du joueur
    points.push(new THREE.Vector3(visionData.playerX, 0.15, visionData.playerZ));
    
    // Ajouter tous les points de raycasting
    for (const point of visionData.raycastPoints) {
      points.push(new THREE.Vector3(point.x, 0.15, point.z));
    }
    
    // Fermer la forme en revenant au joueur
    points.push(new THREE.Vector3(visionData.playerX, 0.15, visionData.playerZ));
    
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    shapeRef.current.geometry.dispose();
    shapeRef.current.geometry = geometry;
  }, [visionData]);
  
  return (
    <line ref={shapeRef}>
      <bufferGeometry />
      <lineBasicMaterial color="#0000ff" linewidth={2} />
    </line>
  );
}

function Bot({ visionData, showRaycast }: { visionData: VisionData; showRaycast: boolean }) {
    // Vie de l'ennemi
    const [botHealth, setBotHealth] = useState(100);
  const botSpotLightRef = useRef<THREE.SpotLight>(null);
  const botTargetRef = useRef<THREE.Object3D>(new THREE.Object3D());
  const [botFlashlightOn, setBotFlashlightOn] = useState(true);
  const [isVisible, setIsVisible] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastFootstepTime = useRef(0);
  
  // Utiliser un spawn de la map pour le bot (spawn 5)
  const botSpawns = getSpawns();
  const botSpawn = botSpawns.length > 4 ? botSpawns[4] : { x: 30, z: 30 };
  const botPositionRef = useRef({ x: botSpawn.x, z: botSpawn.z, direction: 1 }); // direction: 1 = right, -1 = left
  
  // Audio raytracing function
  const calculateAudioParameters = (sourceX: number, sourceZ: number, listenerX: number, listenerZ: number, walls: any[]) => {
    const dx = sourceX - listenerX;
    const dz = sourceZ - listenerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    let blocked = false;
    const numSamples = Math.ceil(distance / 0.5);
    
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      const sampleX = listenerX + dx * t;
      const sampleZ = listenerZ + dz * t;
      
      for (const wall of walls) {
        const halfWidth = wall.width / 2;
        const halfDepth = wall.depth / 2;
        const minX = wall.x - halfWidth;
        const maxX = wall.x + halfWidth;
        const minZ = wall.z - halfDepth;
        const maxZ = wall.z + halfDepth;
        
        if (sampleX >= minX && sampleX <= maxX && sampleZ >= minZ && sampleZ <= maxZ) {
          blocked = true;
          break;
        }
      }
      if (blocked) break;
    }
    
    let volume = 1.0 / (1.0 + distance * 0.05);
    if (blocked) {
      volume *= 0.15;
    }
    
    const angle = Math.atan2(dx, dz);
    const pan = Math.sin(angle) * 0.8;
    
    return { volume: Math.min(volume, 1.0), pan };
  };
  
  const playBotFootstep = (botX: number, botZ: number) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    const audioContext = audioContextRef.current;
    const { volume, pan } = calculateAudioParameters(botX, botZ, visionData.playerX, visionData.playerZ, visionData.walls);
    
    // Heavy footstep sound
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const panner = audioContext.createStereoPanner();
    
    osc.connect(gain);
    gain.connect(panner);
    panner.connect(audioContext.destination);
    
    osc.frequency.value = 60;
    osc.type = 'sine';
    panner.pan.value = pan;
    
    gain.gain.setValueAtTime(0.4 * volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
    
    osc.start(audioContext.currentTime);
    osc.stop(audioContext.currentTime + 0.15);
  };
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'f') {
        setBotFlashlightOn(prev => !prev);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  useFrame((state, delta) => {
    // Gestion des dégâts : collision projectiles <-> bot
    // On récupère la liste des projectiles depuis window (hack simple)
    // @ts-ignore
    const playerProjectiles = window.__playerProjectiles || [];
    const botX_proj = botPositionRef.current.x;
    const botZ_proj = botPositionRef.current.z;
    // @ts-ignore
    const hitProjectiles: number[] = window.__hitProjectiles || [];
    for (const p of playerProjectiles) {
      const dx = p.x - botX_proj;
      const dz = p.z - botZ_proj;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.7 && !hitProjectiles.includes(p.id)) {
        setBotHealth(h => Math.max(0, h - (p.damage || 10)));
        hitProjectiles.push(p.id);
      }
    }
    // @ts-ignore
    window.__hitProjectiles = hitProjectiles;
    
    // Dégâts des zones de feu sur le bot
    // @ts-ignore
    const fireZones = window.__fireZones || [];
    for (const f of fireZones) {
      const dx = botX_proj - f.x;
      const dz = botZ_proj - f.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < f.radius) {
        // 15 dégâts par seconde dans le feu
        setBotHealth(h => Math.max(0, h - 15 * delta));
      }
    }
    
    // Si le bot n'a plus de vie, on le cache
    if (botHealth <= 0) {
      setIsVisible(false);
      return;
    }
    // Move bot left and right
    const botSpeed = 3; // units per second
    botPositionRef.current.x += botPositionRef.current.direction * botSpeed * delta;
    
    // Change direction at bounds (nouvelle map: -70 à +70 en X)
    if (botPositionRef.current.x > 60) {
      botPositionRef.current.direction = -1;
    } else if (botPositionRef.current.x < -60) {
      botPositionRef.current.direction = 1;
    }
    
    const botX = botPositionRef.current.x;
    const botZ = botPositionRef.current.z;
    
    // Play bot footstep sound periodically
    const now = state.clock.elapsedTime;
    if (now - lastFootstepTime.current > 0.6) {
      playBotFootstep(botX, botZ);
      lastFootstepTime.current = now;
    }
    
    // Vérifier si le bot est dans le FOV de raycasting
    
    if (visionData.raycastPoints.length === 0) {
      setIsVisible(false);
      return;
    }
    
    const dx = botX - visionData.playerX;
    const dz = botZ - visionData.playerZ;
    
    // Calculer l'angle du bot par rapport au joueur
    const botAngle = Math.atan2(dx, dz);
    const fovAngle = Math.PI / 3; // 60 degrés
    
    // Normaliser les angles
    let angleDiff = botAngle - visionData.mouseAngle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    
    // Vérifier si le bot est dans le cône de vision
    if (Math.abs(angleDiff) > fovAngle / 2) {
      setIsVisible(false);
    } else {
      const numRays = visionData.raycastPoints.length;
      const rayIndex = Math.floor(((angleDiff + fovAngle / 2) / fovAngle) * (numRays - 1));
      const clampedIndex = Math.max(0, Math.min(numRays - 1, rayIndex));
      
      const rayPoint = visionData.raycastPoints[clampedIndex];
      const maxDistX = rayPoint.x - visionData.playerX;
      const maxDistZ = rayPoint.z - visionData.playerZ;
      const maxDist = Math.sqrt(maxDistX * maxDistX + maxDistZ * maxDistZ);
      
      const botDist = Math.sqrt(dx * dx + dz * dz);
      
      setIsVisible(botDist <= maxDist + 1);
    }
    
    if (botSpotLightRef.current && botTargetRef.current) {
      // Update spotlight position to follow bot
      botSpotLightRef.current.position.set(botX, 1, botZ);
      
      // Direction du bot (vers le sud, +Z)
      const dirX = 0;
      const dirZ = 1;
      const maxDistance = 80; // Distance max de la lampe
      
      let rayX = botX;
      let rayZ = botZ;
      let marchDistance = 0;
      
      // Raymarching pour détecter collision avec les murs
      while (marchDistance < maxDistance) {
        let minDist = Infinity;
        
        for (const wall of visionData.walls) {
          const halfWidth = wall.width / 2;
          const halfDepth = wall.depth / 2;
          
          // Distance au rectangle (SDF)
          const dx = Math.abs(rayX - wall.x) - halfWidth;
          const dz = Math.abs(rayZ - wall.z) - halfDepth;
          
          // Si on est à l'intérieur du rectangle
          if (dx < 0 && dz < 0) {
            minDist = 0;
            break;
          }
          
          // Distance au bord du rectangle
          const dist = dx > 0 && dz > 0 
            ? Math.sqrt(dx * dx + dz * dz) // Coin
            : Math.max(dx, dz); // Bord
          
          minDist = Math.min(minDist, dist);
        }
        
        // Si on est très proche d'un mur, on arrête
        if (minDist <= 0.5) {
          break;
        }
        
        // Avancer du minimum de la distance au mur
        const step = Math.min(Math.max(minDist * 0.9, 0.1), 0.3);
        rayX += dirX * step;
        rayZ += dirZ * step;
        marchDistance += step;
      }
      
      // Faire pointer la lampe vers la position calculée par raymarching
      botTargetRef.current.position.set(rayX, 0, rayZ);
      botSpotLightRef.current.target = botTargetRef.current;
      botSpotLightRef.current.target.updateMatrixWorld();
    }
  });
  
  return (
    <>
      {/* Bot immobile - visible seulement dans le FOV */}
      {isVisible && botHealth > 0 && (
        <mesh position={[botPositionRef.current.x, 0.5, botPositionRef.current.z]}>
          <cylinderGeometry args={[0.5, 0.5, 1, 8]} />
          <meshStandardMaterial color="#4a90e2" />
        </mesh>
      )}
      {/* Affichage de la vie du bot */}
      {isVisible && botHealth > 0 && (
        <group position={[botPositionRef.current.x, 1.3, botPositionRef.current.z]}>
          <mesh>
            <boxGeometry args={[1, 0.15, 0.1]} />
            <meshStandardMaterial color="#222" />
          </mesh>
          <mesh position={[-0.5 + botHealth / 200, 0, 0.06]}>
            <boxGeometry args={[botHealth / 100, 0.1, 0.05]} />
            <meshStandardMaterial color="#e74c3c" />
          </mesh>
        </group>
      )}
      
      {/* Lampe torche du bot - visible seulement si le bot est dans le FOV */}
      <spotLight
        ref={botSpotLightRef}
        position={[botPositionRef.current.x, 1, botPositionRef.current.z]}
        angle={Math.PI / 6}
        penumbra={0.05}
        distance={80}
        intensity={botFlashlightOn && isVisible ? 20 : 0}
        color="#ffffff"
      />
      
      <primitive object={botTargetRef.current} />
    </>
  );
}

// Cone intersection visualizer: samples the 2D area and shows overlap points
function ConeIntersectionVisualizer({ visionData }: { visionData: VisionData }) {
  const pointsGeomRef = useRef<THREE.BufferGeometry>(new THREE.BufferGeometry());
  const groupRef = useRef<THREE.Group>(null);

  // Cone definitions: player cone from visionData, bot cone fixed (can be changed)
  const playerCone = useMemo(() => ({
    x: visionData.playerX,
    y: visionData.playerZ,
    angle: visionData.mouseAngle,
    fov: Math.PI / 3,
    range: (() => {
      // approximate player range from raycast points: take max distance
      if (visionData.raycastPoints.length === 0) return 0;
      let maxd = 0;
      for (const p of visionData.raycastPoints) {
        const dx = p.x - visionData.playerX;
        const dz = p.z - visionData.playerZ;
        maxd = Math.max(maxd, Math.sqrt(dx * dx + dz * dz));
      }
      return maxd;
    })()
  }), [visionData]);

  const botX = 30;
  const botZ = 30;
  const botCone = useMemo(() => ({
    x: botX,
    y: botZ,
    angle: 0.0, // looking +Z
    fov: Math.PI / 6,
    range: 80
  }), []);

  // point-in-cone test
  const pointInCone = (px: number, pz: number, cone: any) => {
    const cx = cone.x;
    const cz = cone.y;
    const ang = cone.angle;
    const fov = cone.fov;
    const range = cone.range;

    const dx = px - cx;
    const dz = pz - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > range + 1e-6) return false;
    let pointAngle = Math.atan2(dx, dz);
    let diff = pointAngle - ang;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return Math.abs(diff) <= fov / 2;
  };

  useFrame(() => {
    // quick reject: distance between cones > sum ranges
    const px = visionData.playerX;
    const pz = visionData.playerZ;
    const pr = playerCone.range;
    const dx = px - botCone.x;
    const dz = pz - botCone.y;
    const centerDist = Math.sqrt(dx * dx + dz * dz);
    if (centerDist > pr + botCone.range) {
      // clear geometry
      if (pointsGeomRef.current) {
        pointsGeomRef.current.setAttribute('position', new THREE.BufferAttribute(new Float32Array([]), 3));
        pointsGeomRef.current.computeBoundingSphere();
      }
      return;
    }

    // bounding box for sampling
    const maxRange = Math.max(pr, botCone.range);
    const minX = Math.min(px, botCone.x) - maxRange;
    const maxX = Math.max(px, botCone.x) + maxRange;
    const minZ = Math.min(pz, botCone.y) - maxRange;
    const maxZ = Math.max(pz, botCone.y) + maxRange;

    // sampling step (world units) - ~1 unit is reasonable; user can adjust for perf
    const step = 0.5; // adjust between 0.5..3 for precision/perf

    const positions: number[] = [];
    const maxSamples = 50000; // cap samples for perf
    let samples = 0;

    for (let x = minX; x <= maxX; x += step) {
      for (let z = minZ; z <= maxZ; z += step) {
        if (samples >= maxSamples) break;
        if (pointInCone(x, z, playerCone) && pointInCone(x, z, botCone)) {
          // push world position (x, y, z)
          positions.push(x, 0.6, z);
        }
        samples++;
      }
      if (samples >= maxSamples) break;
    }

    // create/update buffer geometry for points
    if (!pointsGeomRef.current) {
      pointsGeomRef.current = new THREE.BufferGeometry();
    }
    const posArray = new Float32Array(positions);
    pointsGeomRef.current.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
    pointsGeomRef.current.computeBoundingSphere();

  }, [visionData]);

  // create cone mesh geometry helper
  const makeConeGeometry = (cx: number, cz: number, ang: number, fov: number, range: number, segments = 24) => {
    const vertices: number[] = [];
    const indices: number[] = [];
    // center
    vertices.push(cx, 0.55, cz);
    // arc points
    const start = ang - fov / 2;
    for (let i = 0; i <= segments; i++) {
      const a = start + (fov * (i / segments));
      const x = cx + Math.sin(a) * range;
      const z = cz + Math.cos(a) * range;
      vertices.push(x, 0.55, z);
    }
    // indices for triangle fan
    for (let i = 1; i <= segments; i++) {
      indices.push(0, i, i + 1);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    return geom;
  };

  // player cone geometry (updates every frame)
  const playerGeom = useMemo(() => {
    const px = playerCone.x;
    const pz = playerCone.y;
    const ang = playerCone.angle;
    const range = playerCone.range;
    if (range <= 0) return null;
    return makeConeGeometry(px, pz, ang, playerCone.fov, range, 32);
  }, [playerCone.x, playerCone.y, playerCone.angle, playerCone.range]);

  const botGeom = useMemo(() => makeConeGeometry(botCone.x, botCone.y, botCone.angle, botCone.fov, botCone.range, 24), []);

  return (
    <group ref={groupRef}>
      {/* player cone (blue translucent) */}
      {playerGeom && (
        <mesh geometry={playerGeom} renderOrder={2000}>
          <meshBasicMaterial color="#0000ff" transparent opacity={0.18} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* bot cone (red translucent) */}
      {botGeom && (
        <mesh geometry={botGeom} renderOrder={2001}>
          <meshBasicMaterial color="#ff0000" transparent opacity={0.18} side={THREE.DoubleSide} />
        </mesh>
      )}
      {/* intersection points as violet dots */}
      <points geometry={pointsGeomRef.current} renderOrder={2100}>
        <pointsMaterial size={1.2} color="#FF00FF" sizeAttenuation={false} depthTest={false} />
      </points>
    </group>
  );
}

export default function Scene3D() {
  const [settings, setSettings] = useState<GameSettings>({
    flashlightAngle: 30,
    flashlightIntensity: 100,
    playerSpeed: 5,
    ambientLight: 0.1,
  });
  
  const [showRaycast, setShowRaycast] = useState(true);
  const [playerHealth, setPlayerHealth] = useState(100);
  const [playerStamina, setPlayerStamina] = useState(100);
  const [ringTimer, setRingTimer] = useState(7 * 60); // 7 minutes en secondes
  const [ringRadius, setRingRadius] = useState(80);
  const [currentWeapon, setCurrentWeapon] = useState<'shotgun' | 'pistol'>('shotgun');
  const [isDead, setIsDead] = useState(false);
  const [deathCause, setDeathCause] = useState<string>('');
  const gameStartTimeRef = useRef(Date.now());
  
  // Détecter la mort du joueur
  useEffect(() => {
    if (playerHealth <= 0 && !isDead) {
      setIsDead(true);
      setDeathCause('Vous avez été éliminé !');
    }
  }, [playerHealth, isDead]);
  
  // Fonction pour relancer la partie
  const respawnPlayer = () => {
    setPlayerHealth(100);
    setPlayerStamina(100);
    setIsDead(false);
    setDeathCause('');
    gameStartTimeRef.current = Date.now();
    setRingTimer(7 * 60);
    setRingRadius(80);
    // Envoyer le respawn au serveur
    sendRespawn();
    // Réinitialiser la position du joueur via un événement
    window.dispatchEvent(new CustomEvent('playerRespawn'));
  };
  
  // Écouter les changements d'arme depuis le composant Player
  useEffect(() => {
    const handleWeaponChange = (e: CustomEvent) => {
      setCurrentWeapon(e.detail.weapon);
    };
    window.addEventListener('weaponChange' as any, handleWeaponChange);
    return () => window.removeEventListener('weaponChange' as any, handleWeaponChange);
  }, []);
  
  // Hook multijoueur
  const {
    connected,
    playerId,
    remotePlayers,
    remoteProjectiles,
    remoteFireZones,
    ringRadius: serverRingRadius,
    ringTimer: serverRingTimer,
    chatMessages,
    playerCount,
    sendMove,
    sendShoot,
    sendMolotov,
    sendToggleFlashlight,
    sendTakeDamage,
    sendRespawn,
    sendChat
  } = useMultiplayer(SERVER_URL);
  
  // Callbacks multijoueur pour les composants enfants
  const multiplayerCallbacks: MultiplayerCallbacks = {
    sendMove,
    sendShoot,
    sendMolotov,
    sendToggleFlashlight
  };
  
  // Timer pour le ring (utilise les données du serveur si connecté)
  useEffect(() => {
    const interval = setInterval(() => {
      if (connected) {
        setRingTimer(serverRingTimer);
        setRingRadius(serverRingRadius);
      } else {
        const elapsed = (Date.now() - gameStartTimeRef.current) / 1000;
        const remaining = Math.max(0, 7 * 60 - elapsed);
        setRingTimer(remaining);
        // @ts-ignore
        const currentRadius = window.__ringRadius || 80;
        setRingRadius(currentRadius);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [connected, serverRingRadius, serverRingTimer]);
  
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'y') {
        setShowRaycast(prev => !prev);
      }
      // Espace pour respawn quand mort
      if (e.key === ' ' && isDead) {
        e.preventDefault();
        respawnPlayer();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDead]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full h-screen relative">
      {/* Écran de mort */}
      {isDead && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="text-center">
            {/* Icône de mort */}
            <div className="text-8xl mb-6 animate-pulse">💀</div>
            
            {/* Titre */}
            <h1 className="text-6xl font-bold text-red-600 mb-4 tracking-wider" style={{ textShadow: '0 0 20px rgba(220, 38, 38, 0.5)' }}>
              MORT
            </h1>
            
            {/* Cause de la mort */}
            <p className="text-xl text-gray-300 mb-8">{deathCause}</p>
            
            {/* Stats */}
            <div className="bg-black/50 rounded-lg p-4 mb-8 inline-block">
              <div className="text-gray-400 text-sm mb-2">Temps survécu</div>
              <div className="text-2xl text-white font-bold">
                {formatTime(7 * 60 - ringTimer)}
              </div>
            </div>
            
            {/* Bouton de respawn */}
            <div>
              <button
                onClick={respawnPlayer}
                className="px-8 py-4 bg-gradient-to-r from-red-600 to-red-800 hover:from-red-500 hover:to-red-700 text-white text-xl font-bold rounded-lg transition-all duration-200 transform hover:scale-105 shadow-lg hover:shadow-red-500/50"
              >
                🔄 REJOUER
              </button>
            </div>
            
            {/* Instruction */}
            <p className="text-gray-500 text-sm mt-4">Appuyez sur Espace ou cliquez pour rejouer</p>
          </div>
        </div>
      )}
      
      {/* Indicateur de connexion */}
      <div className={`absolute top-4 right-4 z-20 px-4 py-2 rounded-lg ${connected ? 'bg-green-600' : 'bg-red-600'} text-white text-sm font-bold`}>
        {connected ? `🟢 Connecté (${playerCount} joueurs)` : '🔴 Hors ligne'}
      </div>
      
      {/* Timer du Ring Battle Royale */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 bg-black/90 text-white px-6 py-3 rounded-lg border-2 border-cyan-500">
        <div className="text-center">
          <div className="text-xs text-cyan-400 uppercase tracking-wider">Zone</div>
          <div className="text-2xl font-bold text-cyan-300">{formatTime(ringTimer)}</div>
          <div className="text-xs text-gray-400">Rayon: {Math.round(ringRadius)}m</div>
        </div>
      </div>
      
      {/* Overlay de contrôles */}
      <div className="absolute left-4 top-4 z-10 bg-black/80 text-white p-4 rounded-lg w-64 space-y-4">
        <h2 className="text-xl font-bold mb-4">Contrôles</h2>
        
        <div className="space-y-2">
          <label className="block text-sm">
            Angle lampe: {settings.flashlightAngle}°
          </label>
          <input
            type="range"
            min="10"
            max="90"
            value={settings.flashlightAngle}
            onChange={(e) => setSettings({ ...settings, flashlightAngle: Number(e.target.value) })}
            className="w-full"
          />
        </div>
        
        <div className="space-y-2">
          <label className="block text-sm">
            Intensité lampe: {settings.flashlightIntensity}
          </label>
          <input
            type="range"
            min="1"
            max="100"
            value={settings.flashlightIntensity}
            onChange={(e) => setSettings({ ...settings, flashlightIntensity: Number(e.target.value) })}
            className="w-full"
          />
        </div>
        
        <div className="space-y-2">
          <label className="block text-sm">
            Vitesse joueur: {settings.playerSpeed.toFixed(1)}
          </label>
          <input
            type="range"
            min="1"
            max="20"
            step="0.5"
            value={settings.playerSpeed}
            onChange={(e) => setSettings({ ...settings, playerSpeed: Number(e.target.value) })}
            className="w-full"
          />
        </div>
        
        <div className="space-y-2">
          <label className="block text-sm">
            Lumière globale: {settings.ambientLight.toFixed(2)}
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.ambientLight}
            onChange={(e) => setSettings({ ...settings, ambientLight: Number(e.target.value) })}
            className="w-full"
          />
        </div>
        
        <div className="mt-4 pt-4 border-t border-white/30 text-xs space-y-1">
          <p><span className="font-bold">ZQSD</span> : Déplacer</p>
          <p><span className="font-bold">Shift</span> : Courir</p>
          <p><span className="font-bold">G</span> : Cocktail Molotov</p>
          <p><span className="font-bold">E</span> : Lampe ON/OFF</p>
          <p><span className="font-bold">F</span> : Lampe bot ON/OFF</p>
          <p><span className="font-bold">Y</span> : FOV raycast {showRaycast ? 'ON' : 'OFF'}</p>
          <p><span className="font-bold">Molette</span> : Changer d'arme</p>
          <p><span className="font-bold">Souris</span> : Orienter lampe</p>
          <p><span className="font-bold">Clic gauche</span> : Tirer</p>
        </div>
      </div>
      
      {/* Indicateur d'arme actuelle */}
      <div className="absolute bottom-24 right-4 z-10 bg-black/80 text-white p-3 rounded-lg border border-gray-600">
        <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Arme</div>
        <div className="flex gap-2">
          <div className={`px-3 py-2 rounded ${currentWeapon === 'shotgun' ? 'bg-orange-600' : 'bg-gray-700'} transition-colors`}>
            <div className="text-sm font-bold">🔫</div>
            <div className="text-xs">Fusil</div>
          </div>
          <div className={`px-3 py-2 rounded ${currentWeapon === 'pistol' ? 'bg-blue-600' : 'bg-gray-700'} transition-colors`}>
            <div className="text-sm font-bold">🔫</div>
            <div className="text-xs">Pistolet</div>
          </div>
        </div>
        <div className="text-xs text-gray-500 mt-1 text-center">Molette pour changer</div>
      </div>
      
      {/* Barres de vie et d'endurance en bas de l'écran */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-10 flex flex-col gap-2 w-80">
        {/* Barre de vie */}
        <div className="flex items-center gap-2">
          <span className="text-white text-xs font-bold w-8">❤️</span>
          <div className="flex-1 h-4 bg-gray-800 rounded-full overflow-hidden border border-gray-600">
            <div 
              className="h-full bg-gradient-to-r from-red-700 to-red-500 transition-all duration-100"
              style={{ width: `${Math.max(0, Math.min(100, playerHealth))}%` }}
            />
          </div>
          <span className="text-white text-xs font-bold w-12">{Math.max(0, Math.round(playerHealth))}</span>
        </div>
        {/* Barre d'endurance */}
        <div className="flex items-center gap-2">
          <span className="text-white text-xs font-bold w-8">⚡</span>
          <div className="flex-1 h-3 bg-gray-800 rounded-full overflow-hidden border border-gray-600">
            <div 
              className="h-full bg-gradient-to-r from-yellow-600 to-yellow-400 transition-all duration-100"
              style={{ width: `${Math.max(0, Math.min(100, playerStamina))}%` }}
            />
          </div>
          <span className="text-white text-xs font-bold w-12">{Math.max(0, Math.round(playerStamina))}</span>
        </div>
      </div>

      <Canvas camera={{ position: [0, 30, 0], fov: 75 }}>
        <Scene 
          settings={settings} 
          showRaycast={showRaycast} 
          setPlayerHealth={setPlayerHealth} 
          setPlayerStamina={setPlayerStamina}
          multiplayer={multiplayerCallbacks}
          remotePlayers={remotePlayers}
          remoteProjectiles={remoteProjectiles}
          remoteFireZones={remoteFireZones}
        />
      </Canvas>
    </div>
  );
}
