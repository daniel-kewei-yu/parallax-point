/*
Author: Daniel Yu
Date: March 15, 2026
Description: Entry point for the Parallax-Point client. This file initialises the entire client application:
             it creates the Three.js scene and renderer, builds the static world geometry, creates the local
             player's physics capsule and character model, connects to the physics SharedWorker, sets up
             input handlers, and starts all game loops (input, animation, render, UI updates). It also
             initialises the remote player manager. The init() function is called immediately to launch
             the client.
*/

// Import client configuration constants (player dimensions, model offsets, etc.).
import { CLIENT_CONFIG } from './clientConfig.js';
// Import the global game state singleton (scene, camera, renderer, player state, etc.).
import { GameState } from './clientState.js';
// Import the function to set up the Three.js renderer and scene.
import { setupRendering } from './rendering/setup.js';
// Import the function to build the static world geometry (walls, floor, platforms).
import { buildWorld } from './rendering/worldGeometry.js';
// Import the function to connect to the physics SharedWorker.
import { connectToWorker } from './network/workerClient.js';
// Import the RemotePlayerManager to initialise it after the worker connects.
import { RemotePlayerManager } from './players/RemotePlayerManager.js';
// Import the FirstPersonCharacter class to create the local player character.
import { FirstPersonCharacter } from './players/FirstPersonCharacter.js';
// Import functions to set up input handlers and start the input loop.
import { setupInput, startInputLoop } from './input/inputHandler.js';
// Import the function to start the animation loop (fixed-rate updates).
import { startAnimationLoop } from './animation/animationLoop.js';
// Import the function to start the render loop (requestAnimationFrame).
import { startRenderLoop } from './animation/renderLoop.js';
// Import the function to start the UI updater (player count display).
import { startPlayerCountUpdater } from './ui/uiUpdater.js';
// Import Three.js core for geometry and materials (used for the physics capsule).
import * as THREE from 'three';

/**
 * Initialises the entire client application. This function is called immediately
 * after the module loads. It performs all setup steps in the correct order.
 * @param {void} - No parameters.
 * @returns {void}
 */
function init() {
    // Step 1: Create the Three.js scene and renderer (with stencil buffer, shadows).
    const { scene, renderer } = setupRendering();
    // Store references in the global state for other modules to access.
    GameState.scene = scene;
    GameState.renderer = renderer;

    // Step 2: Build the static world geometry (walls, floor, platforms, ring walls, pillars).
    buildWorld();

    // Step 3: Create an invisible collision capsule for the local player.
    // This capsule represents the player's physical collision shape and is used
    // for visual debugging and portal detection.
    const cylinderGeom = new THREE.CylinderGeometry(
        CLIENT_CONFIG.PLAYER_RADIUS, // Radius at the top.
        CLIENT_CONFIG.PLAYER_RADIUS, // Radius at the bottom.
        CLIENT_CONFIG.PLAYER_HEIGHT, // Height of the capsule (cylinder).
        8                             // Segments for smoothness.
    );
    // Create a white, opaque material (the capsule is visible for debugging).
    const cylinderMat = new THREE.MeshPhongMaterial({
        color: 0xffffff,
        transparent: false,
        opacity: 1,
    });
    // Instantiate the mesh.
    const capsule = new THREE.Mesh(cylinderGeom, cylinderMat);
    // Position the capsule so its bottom is at the foot (y=0) and centre is at half height.
    capsule.position.y = CLIENT_CONFIG.PLAYER_HEIGHT / 2;
    // Tag the capsule so we can identify it in raycasts and portal rendering.
    capsule.userData.isLocalPlayerPart = true;
    capsule.userData.isPhysicsCapsule = true;
    // Add the capsule to the scene.
    GameState.scene.add(capsule);
    // Store the capsule in the physicsPlayer object of the global state.
    GameState.physicsPlayer = { capsule };

    // Step 4: Create the local player character (model, animations, camera).
    // This loads the GLTF model, sets up animation mixers, and attaches the camera.
    GameState.firstPersonChar = new FirstPersonCharacter(scene);

    // Step 5: Connect to the physics SharedWorker and initialise the remote player manager.
    connectToWorker();                 // Establishes the worker connection and sends join message.
    RemotePlayerManager.init();        // Loads models for remote players.

    // Step 6: Set up input handlers and start all game loops.
    setupInput();                      // Registers keyboard, mouse, and pointer lock events.
    startInputLoop();                  // Begins sending input to the worker at fixed intervals.
    startAnimationLoop();              // Begins updating animations at ~60 Hz.
    startRenderLoop();                 // Begins the rendering loop (requestAnimationFrame).
    startPlayerCountUpdater();         // Periodically updates the player count display.
}

// Immediately execute the initialisation function to start the client.
init();