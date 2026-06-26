# Parallax-Point

A multiplayer first-person sandbox game built with Three.js and Cannon.es.  
Pick up and throw blocks, equip a portal gun, place portals, and interact with other players in a shared physics world.

## Features

- **Real-time multiplayer** via SharedWorker physics simulation.
- **First-person movement** with jumping and mouse look.
- **Two grab mechanics**: forced perspective (E) and rigid rod (Q when portal gun equipped).
- **Equipable portal gun** with left/right click to place blue/orange portals.
- **Portals** are per-player, two-way, and preserve orientation and velocity. Each player can place one blue and one orange portal; they only pair with each other.
- **Animated player models** (walk, idle, jump) with separated upper/lower body.
- **Crosshair feedback** changes colour when hovering over grabbable objects.
- **Sandbox world** with platforms, pillars, and walls.

## How to Run

1. **Clone the repository**  
   `git clone <your-repo-url>`  
   `cd parallax-point`

2. **Start a local web server**  
   The game requires a server to load assets correctly:

   - **Python 3** (built-in):  
     `python -m http.server 8000`

   - **Node.js** (with `npx`):  
     `npx serve .`

   - **VS Code** (with Live Server extension):  
     - Install "Live Server" by Ritwick Dey.  
     - Right-click `index.html` → "Open with Live Server".

3. **Open your browser**  
   Navigate to the local address (e.g., `http://localhost:8000`).  
   Click the canvas to lock the pointer and start playing.

## Controls

| Key / Action        | Effect                                      |
|---------------------|---------------------------------------------|
| `WASD`              | Move                                        |
| `Space`             | Jump                                        |
| `E`                 | Grab / drop object (forced perspective)     |
| `Q` (gun equipped)  | Grab / drop object (rigid rod)              |
| `F`                 | Equip / unequip portal gun                  |
| Left click          | Place blue portal                           |
| Right click         | Place orange portal                         |
| Mouse               | Look around                                 |

**Crosshair feedback:**
- **Green** – Grabbable object (owned by you or unowned)
- **Red** – Block owned by another player (cannot grab)
- **White** – Nothing grabbable under crosshair

## Project Structure

```
parallax-point/
├── index.html
├── styles/
│   └── main.css
├── assets/
│   └── models/
│       ├── thePlayer.glb
│       └── portalGun.glb
├── src/
│   ├── client/
│   │   ├── clientMain.js
│   │   ├── clientConfig.js
│   │   ├── clientState.js
│   │   ├── clientUtils.js
│   │   ├── rendering/
│   │   │   ├── setup.js
│   │   │   └── worldGeometry.js
│   │   ├── players/
│   │   │   ├── FirstPersonCharacter.js
│   │   │   └── RemotePlayerManager.js
│   │   ├── mechanics/
│   │   │   ├── ForcedPerspective.js
│   │   │   ├── blockManager.js
|   |   |   └── portalMechanics/
│   |   |       ├── Portal.js
│   |   |       ├── PortalInteraction.js
│   |   |       ├── PortalManager.js
│   |   |       ├── PortalProxyManager.js
│   |   |       ├── PortalRenderer.js
│   |   |       ├── PortalSystem.js
│   |   |       ├── ObliqueNearPlane.js
│   │   │       ├── PortalPickup.js
│   │   │       ├── blockManager.js
│   │   ├── input/
│   │   │   └── inputHandler.js
│   │   ├── animation/
│   │   │   ├── animationLoop.js
│   │   │   └── renderLoop.js
│   │   ├── network/
│   │   │   └── workerClient.js
│   │   └── ui/
│   │       └── uiUpdater.js
│   ├── worker/
│   │   ├── physicsSharedWorker.js
│   │   ├── worker_config.js
│   │   ├── worker_world.js
│   │   ├── worker_block.js
│   │   ├── worker_player.js
│   │   ├── worker_handlers.js
│   │   ├── worker_portal.js
│   │   ├── worker_broadcast.js
│   │   └── worker_physicsLoop.js
│   └── shared/
│       └── gameConstants.js
├── package.json
└── README.md
```

## Development

- No development tools are required. Simply serve the project with a static server.

## Future Improvements

- Add portal interaction for held objects
- More block types (e.g., dynamic shapes)
- Sound effects and music
- Settings menu (mouse sensitivity, volume)

## Credits

- **Three.js** – 3D rendering
- **Cannon.es** – Physics engine
- **GLB Models**: X Bot (Mixamo, Adobe) – converted to GLB and combined with animations (Idle, Crouched Walking, Jump, Pull Out) also sourced from Mixamo. The final model is a custom asset created by the author.
- **Superliminal / Museum of Simulation Technology Demo** – Inspiration for forced‑perspective grab
- **Portal 2 / Garry's Mod** – Inspiration for portal gun mechanics, orientation preservation, and multiplayer sandbox

## License

MIT License  
Copyright © 2026 Daniel Kewei Yu