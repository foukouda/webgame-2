# Next.js + Three.js Project

Projet web combinant Next.js et Three.js pour créer des expériences 3D interactives.

## 🚀 Technologies

- **Next.js 16** - Framework React pour le développement web
- **TypeScript** - Typage statique
- **Three.js** - Bibliothèque 3D pour le web
- **React Three Fiber** - Renderer React pour Three.js
- **React Three Drei** - Helpers utiles pour React Three Fiber
- **Tailwind CSS** - Framework CSS utility-first

## 📦 Structure du projet

```
webgame-2/
├── src/
│   ├── app/
│   │   ├── page.tsx          # Page principale avec scène 3D
│   │   ├── layout.tsx         # Layout de base
│   │   └── globals.css        # Styles globaux
│   └── components/
│       └── Scene3D.tsx        # Composant de scène 3D
├── public/                    # Assets statiques
├── package.json
└── tsconfig.json
```

## 💻 Démarrage

Lancez le serveur de développement :

```bash
npm run dev
```

Ouvrez [http://localhost:3000](http://localhost:3000) dans votre navigateur.

## 🎮 Utilisation

La scène 3D est interactive :
- **Clic gauche + glisser** : Rotation de la caméra
- **Clic droit + glisser** : Pan (déplacement latéral)
- **Molette** : Zoom avant/arrière

## 🎨 Personnalisation

### Modifier le cube

Éditez `src/components/Scene3D.tsx` pour modifier l'objet 3D :

```tsx
<Box ref={meshRef} args={[2, 2, 2]}>
  <meshStandardMaterial color="royalblue" />
</Box>
```

### Ajouter des objets 3D

Vous pouvez ajouter d'autres formes depuis `@react-three/drei` :
- `<Sphere />` - Sphère
- `<Torus />` - Tore
- `<Cone />` - Cône
- `<Cylinder />` - Cylindre

## 📝 Commandes disponibles

- `npm run dev` - Lance le serveur de développement
- `npm run build` - Compile le projet pour la production
- `npm start` - Lance le serveur de production
- `npm run lint` - Vérifie le code avec ESLint

## 📚 Ressources

- [Documentation Next.js](https://nextjs.org/docs)
- [Documentation Three.js](https://threejs.org/docs)
- [Documentation React Three Fiber](https://docs.pmnd.rs/react-three-fiber)
- [Documentation Drei](https://github.com/pmndrs/drei)

## 🎯 Prochaines étapes

Vous pouvez maintenant :
1. Modifier la scène 3D dans `src/components/Scene3D.tsx`
2. Ajouter de nouveaux composants 3D
3. Créer des animations personnalisées
4. Intégrer des modèles 3D (GLTF, FBX, etc.)
5. Ajouter des interactions utilisateur avancées

Bon développement ! 🚀
