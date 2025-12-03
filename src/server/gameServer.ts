import { Server } from 'socket.io';
import { createServer } from 'http';

interface Player {
  id: string;
  x: number;
  z: number;
  angle: number;
  health: number;
  flashlightOn: boolean;
  name: string;
}

interface Projectile {
  id: string;
  ownerId: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  damage: number;
}

interface FireZone {
  id: string;
  x: number;
  z: number;
  radius: number;
  timeLeft: number;
}

interface GameState {
  players: Map<string, Player>;
  projectiles: Projectile[];
  fireZones: FireZone[];
  ringRadius: number;
  ringTimer: number;
  gameStarted: boolean;
}

const gameState: GameState = {
  players: new Map(),
  projectiles: [],
  fireZones: [],
  ringRadius: 80,
  ringTimer: 7 * 60, // 7 minutes en secondes
  gameStarted: false
};

// Points de spawn depuis la map
const spawnPoints = [
  { x: -33, z: -31 },
  { x: -27, z: -31 },
  { x: -21, z: -31 },
  { x: -6.3, z: -11 },
  { x: -6.1, z: 15 },
  { x: 10, z: 5 },
  { x: 20, z: -15 },
  { x: -15, z: 20 }
];

// Murs pour la détection de collision côté serveur (simplifié)
const walls = [
  { x: -70, z: 0, width: 1, depth: 80 },
  { x: 70, z: 0, width: 1, depth: 80 },
  { x: 0, z: -40, width: 140, depth: 1 },
  { x: 0, z: 40, width: 140, depth: 1 }
];

function getRandomSpawn(): { x: number; z: number } {
  return spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
}

function checkWallCollision(x: number, z: number): boolean {
  for (const wall of walls) {
    const halfWidth = wall.width / 2;
    const halfDepth = wall.depth / 2;
    if (
      x >= wall.x - halfWidth - 0.5 &&
      x <= wall.x + halfWidth + 0.5 &&
      z >= wall.z - halfDepth - 0.5 &&
      z <= wall.z + halfDepth + 0.5
    ) {
      return true;
    }
  }
  return false;
}

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

console.log('🎮 Game Server Starting...');

io.on('connection', (socket) => {
  console.log(`✅ Player connected: ${socket.id}`);
  
  // Spawn du nouveau joueur
  const spawn = getRandomSpawn();
  
  const newPlayer: Player = {
    id: socket.id,
    x: spawn.x,
    z: spawn.z,
    angle: 0,
    health: 100,
    flashlightOn: true,
    name: `Player${Math.floor(Math.random() * 1000)}`
  };
  
  gameState.players.set(socket.id, newPlayer);
  
  // Démarrer le jeu si c'est le premier joueur
  if (!gameState.gameStarted && gameState.players.size >= 1) {
    gameState.gameStarted = true;
    console.log('🎮 Game started!');
  }
  
  // Envoyer l'état initial au nouveau joueur
  socket.emit('init', {
    playerId: socket.id,
    players: Array.from(gameState.players.values()),
    projectiles: gameState.projectiles,
    fireZones: gameState.fireZones,
    ringRadius: gameState.ringRadius,
    ringTimer: gameState.ringTimer
  });
  
  // Informer les autres joueurs
  socket.broadcast.emit('playerJoined', newPlayer);
  
  console.log(`👥 Total players: ${gameState.players.size}`);
  
  // Mise à jour de position
  socket.on('move', (data: { x: number; z: number; angle: number }) => {
    const player = gameState.players.get(socket.id);
    if (player) {
      // Validation basique (anti-cheat léger)
      const dx = data.x - player.x;
      const dz = data.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      
      // Permettre un mouvement max de 2 unités par update
      if (dist < 2) {
        player.x = data.x;
        player.z = data.z;
        player.angle = data.angle;
        socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
      }
    }
  });
  
  // Tir
  socket.on('shoot', (data: { projectiles: Array<{ x: number; z: number; vx: number; vz: number; damage: number }> }) => {
    const player = gameState.players.get(socket.id);
    if (!player || player.health <= 0) return;
    
    const newProjectiles = data.projectiles.map((p, i) => ({
      id: `${socket.id}-${Date.now()}-${i}`,
      ownerId: socket.id,
      x: p.x,
      z: p.z,
      vx: p.vx,
      vz: p.vz,
      damage: p.damage
    }));
    
    gameState.projectiles.push(...newProjectiles);
    io.emit('projectilesFired', { ownerId: socket.id, projectiles: newProjectiles });
  });
  
  // Molotov
  socket.on('molotov', (data: { x: number; z: number; radius: number }) => {
    const player = gameState.players.get(socket.id);
    if (!player || player.health <= 0) return;
    
    const fireZone: FireZone = {
      id: `fire-${socket.id}-${Date.now()}`,
      x: data.x,
      z: data.z,
      radius: data.radius,
      timeLeft: 5000 // 5 secondes
    };
    
    gameState.fireZones.push(fireZone);
    io.emit('fireCreated', fireZone);
  });
  
  // Lampe torche
  socket.on('toggleFlashlight', (on: boolean) => {
    const player = gameState.players.get(socket.id);
    if (player) {
      player.flashlightOn = on;
      socket.broadcast.emit('flashlightToggled', { id: socket.id, on });
    }
  });
  
  // Dégâts reçus
  socket.on('takeDamage', (data: { amount: number; fromPlayerId?: string }) => {
    const player = gameState.players.get(socket.id);
    if (player && player.health > 0) {
      player.health = Math.max(0, player.health - data.amount);
      
      io.emit('playerDamaged', { 
        id: socket.id, 
        health: player.health,
        fromPlayerId: data.fromPlayerId 
      });
      
      if (player.health <= 0) {
        console.log(`💀 Player ${socket.id} died!`);
        io.emit('playerDied', { 
          id: socket.id, 
          killedBy: data.fromPlayerId 
        });
      }
    }
  });
  
  // Respawn
  socket.on('respawn', () => {
    const player = gameState.players.get(socket.id);
    if (player && player.health <= 0) {
      const spawn = getRandomSpawn();
      player.x = spawn.x;
      player.z = spawn.z;
      player.health = 100;
      player.angle = 0;
      
      io.emit('playerRespawned', {
        id: socket.id,
        x: player.x,
        z: player.z,
        health: player.health
      });
      console.log(`🔄 Player ${socket.id} respawned`);
    }
  });
  
  // Chat
  socket.on('chat', (message: string) => {
    const player = gameState.players.get(socket.id);
    if (player) {
      io.emit('chatMessage', {
        playerId: socket.id,
        playerName: player.name,
        message: message.substring(0, 200) // Limite de 200 caractères
      });
    }
  });
  
  // Déconnexion
  socket.on('disconnect', () => {
    console.log(`❌ Player disconnected: ${socket.id}`);
    gameState.players.delete(socket.id);
    io.emit('playerLeft', socket.id);
    console.log(`👥 Total players: ${gameState.players.size}`);
  });
});

// Game loop pour la physique côté serveur (60 ticks/seconde)
const TICK_RATE = 1000 / 60;
let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  
  // Mettre à jour le ring Battle Royale
  if (gameState.gameStarted && gameState.ringRadius > 5) {
    gameState.ringTimer -= delta;
    
    // Réduire le ring progressivement
    const shrinkRate = (80 - 5) / (7 * 60); // De 80 à 5 en 7 minutes
    gameState.ringRadius = Math.max(5, 80 - (7 * 60 - gameState.ringTimer) * shrinkRate);
    
    // Dégâts hors du ring
    const mapCenterX = 0;
    const mapCenterZ = 0;
    
    for (const [id, player] of gameState.players) {
      if (player.health > 0) {
        const dx = player.x - mapCenterX;
        const dz = player.z - mapCenterZ;
        const distFromCenter = Math.sqrt(dx * dx + dz * dz);
        
        if (distFromCenter > gameState.ringRadius) {
          player.health -= 5 * delta; // 5 dégâts/seconde hors zone
          if (player.health <= 0) {
            player.health = 0;
            io.emit('playerDied', { id, killedBy: 'ring' });
          } else {
            io.to(id).emit('ringDamage', player.health);
          }
        }
      }
    }
  }
  
  // Broadcast ring state every second
  if (Math.floor(now / 1000) !== Math.floor((now - TICK_RATE) / 1000)) {
    io.emit('ringUpdate', {
      radius: gameState.ringRadius,
      timer: gameState.ringTimer
    });
  }
  
  // Mettre à jour les projectiles
  const projectilesToRemove: string[] = [];
  
  for (const projectile of gameState.projectiles) {
    projectile.x += projectile.vx * delta;
    projectile.z += projectile.vz * delta;
    
    // Vérifier collision avec murs
    if (checkWallCollision(projectile.x, projectile.z)) {
      projectilesToRemove.push(projectile.id);
      continue;
    }
    
    // Vérifier les collisions avec les joueurs
    for (const [id, player] of gameState.players) {
      if (id !== projectile.ownerId && player.health > 0) {
        const dx = projectile.x - player.x;
        const dz = projectile.z - player.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < 0.7) {
          player.health -= projectile.damage;
          
          io.emit('playerHit', { 
            playerId: id, 
            health: player.health, 
            projectileId: projectile.id,
            fromPlayerId: projectile.ownerId
          });
          
          if (player.health <= 0) {
            player.health = 0;
            io.emit('playerDied', { id, killedBy: projectile.ownerId });
          }
          
          projectilesToRemove.push(projectile.id);
          break;
        }
      }
    }
    
    // Supprimer si hors map
    if (Math.abs(projectile.x) > 80 || Math.abs(projectile.z) > 50) {
      projectilesToRemove.push(projectile.id);
    }
  }
  
  // Supprimer les projectiles marqués
  if (projectilesToRemove.length > 0) {
    gameState.projectiles = gameState.projectiles.filter(p => !projectilesToRemove.includes(p.id));
    io.emit('projectilesRemoved', projectilesToRemove);
  }
  
  // Mettre à jour les zones de feu
  const fireZonesToRemove: string[] = [];
  
  for (const fire of gameState.fireZones) {
    fire.timeLeft -= TICK_RATE;
    
    if (fire.timeLeft <= 0) {
      fireZonesToRemove.push(fire.id);
      continue;
    }
    
    // Dégâts aux joueurs dans la zone
    for (const [id, player] of gameState.players) {
      if (player.health > 0) {
        const dx = fire.x - player.x;
        const dz = fire.z - player.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        
        if (dist < fire.radius) {
          player.health -= 15 * delta; // 15 dégâts/seconde
          io.to(id).emit('fireDamage', player.health);
          
          if (player.health <= 0) {
            player.health = 0;
            io.emit('playerDied', { id, killedBy: 'fire' });
          }
        }
      }
    }
  }
  
  // Supprimer les zones de feu expirées
  if (fireZonesToRemove.length > 0) {
    gameState.fireZones = gameState.fireZones.filter(f => !fireZonesToRemove.includes(f.id));
    io.emit('fireZonesRemoved', fireZonesToRemove);
  }
  
}, TICK_RATE);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 Game server running on port ${PORT}`);
  console.log(`📡 Waiting for players...`);
});
