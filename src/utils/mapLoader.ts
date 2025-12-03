// Utilitaire pour charger et convertir la map JSON vers le format Three.js
import mapData from '../../map.json';

// Facteur d'échelle: 1 pixel = 0.1 unité Three.js
// Map 1400x800 pixels -> 140x80 unités
const SCALE = 0.1;

// Décalage pour centrer la map (la map JSON commence à 0,0)
const OFFSET_X = -70; // -1400/2 * SCALE
const OFFSET_Z = -40; // -800/2 * SCALE

export interface Wall {
  x: number;
  z: number;
  width: number;
  depth: number;
}

export interface WallMesh {
  position: [number, number, number];
  args: [number, number, number];
  color: string;
}

export interface Furniture {
  x: number;
  z: number;
  width: number;
  depth: number;
  type: string;
}

export interface Light {
  x: number;
  z: number;
  type: string;
  color: [number, number, number];
  radius: number;
  intensity: number;
  flicker: boolean;
}

export interface Spawn {
  x: number;
  z: number;
}

// Convertir les murs du format JSON vers le format collision
export function getWalls(): Wall[] {
  return mapData.murs.map((mur: number[]) => {
    const [x, y, width, height] = mur;
    return {
      x: (x + width / 2) * SCALE + OFFSET_X,
      z: (y + height / 2) * SCALE + OFFSET_Z,
      width: width * SCALE,
      depth: height * SCALE
    };
  });
}

// Convertir les murs pour le rendu 3D
export function getWallMeshes(): WallMesh[] {
  return mapData.murs.map((mur: number[]) => {
    const [x, y, width, height] = mur;
    return {
      position: [
        (x + width / 2) * SCALE + OFFSET_X,
        2, // Hauteur du mur
        (y + height / 2) * SCALE + OFFSET_Z
      ] as [number, number, number],
      args: [
        width * SCALE,
        4, // Hauteur du mur
        height * SCALE
      ] as [number, number, number],
      color: "#555555"
    };
  });
}

// Convertir les meubles
export function getFurniture(): Furniture[] {
  return mapData.meubles.map((meuble: { rect: number[]; type: string }) => {
    const [x, y, width, height] = meuble.rect;
    return {
      x: (x + width / 2) * SCALE + OFFSET_X,
      z: (y + height / 2) * SCALE + OFFSET_Z,
      width: width * SCALE,
      depth: height * SCALE,
      type: meuble.type
    };
  });
}

// Convertir les lumières
export function getLights(): Light[] {
  return mapData.lumieres.map((lumiere: { 
    pos: number[]; 
    type: string; 
    couleur: number[]; 
    rayon: number; 
    intensite: number;
    scintille: boolean;
  }) => ({
    x: lumiere.pos[0] * SCALE + OFFSET_X,
    z: lumiere.pos[1] * SCALE + OFFSET_Z,
    type: lumiere.type,
    color: lumiere.couleur as [number, number, number],
    radius: lumiere.rayon * SCALE,
    intensity: lumiere.intensite,
    flicker: lumiere.scintille
  }));
}

// Convertir les spawns
export function getSpawns(): Spawn[] {
  return mapData.spawns.map((spawn: number[]) => ({
    x: spawn[0] * SCALE + OFFSET_X,
    z: spawn[1] * SCALE + OFFSET_Z
  }));
}

// Obtenir la taille de la map
export function getMapSize() {
  return {
    width: 140, // 1400 * 0.1
    height: 80, // 800 * 0.1
    offsetX: OFFSET_X,
    offsetZ: OFFSET_Z
  };
}

// Obtenir un spawn aléatoire pour le joueur
export function getRandomSpawn(): Spawn {
  const spawns = getSpawns();
  return spawns[Math.floor(Math.random() * spawns.length)];
}
