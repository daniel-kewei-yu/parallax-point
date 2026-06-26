/*
Author: Daniel Yu
Date: March 15, 2026
Description: Global state object that holds references to key Three.js objects (scene, camera, renderer)
             and transient state like held objects, input state, remote players, and the local player's
             most recent state from the worker. It also stores portal-related flags for split‑phase
             traversal, teleport synchronisation, and forced perspective/rod pickup state. This singleton
             is imported and used throughout the client code.
*/

import * as THREE from 'three';

/**
 * The global state object for the client.
 * All properties are initialised to null or default values and are set by various modules.
 */
export const GameState = {
    // ---------- Rendering ----------
    /** The Three.js scene containing all objects. */
    scene: null,
    /** The main Three.js camera (first‑person, may be detached during portal traversal). */
    camera: null,
    /** The Three.js WebGLRenderer (with stencil buffer enabled). */
    renderer: null,
    /** Three.js Clock used for delta time calculations in the render loop. */
    clock: new THREE.Clock(),

    // ---------- Player identification ----------
    /** Unique player ID assigned by the worker (e.g., 'p_5'). */
    playerId: null,
    /** The numeric part of the player ID (e.g., 5 from 'p_5'), used for display. */
    myAssignedNumber: null,
    /** Map from player ID to a number (used for labelling remote players). */
    playerNumbers: new Map(),
    /** Next number to assign to a new remote player. */
    nextNumber: 1,

    // ---------- World objects (blocks) ----------
    /** Map from block ID to the corresponding Three.js Mesh. */
    worldObjects: new Map(),

    // ---------- Local player ----------
    /** Object containing the local player's physics capsule mesh: { capsule: Mesh }. */
    physicsPlayer: null,
    /** The FirstPersonCharacter instance (model, animations, camera control). */
    firstPersonChar: null,
    /** Whether pointer lock is active (first‑person mode). */
    controlsLocked: false,

    // ---------- Network ----------
    /** The SharedWorker instance (or its port) for communication with the physics worker. */
    worker: null,
    /** Interval (ms) between sending input messages to the worker. */
    inputInterval: 50,

    // ---------- Holding mechanics ----------
    /** Whether the local player is currently held by another player (forced perspective). */
    isBeingHeld: false,

    // Forced perspective (E) hold
    /** Whether forced‑perspective grab is active. */
    forcedPerspectiveActive: false,
    /** ID of the object being held (block ID or player ID) for forced perspective. */
    heldObjectId: null,
    /** Three.js mesh of the object held by forced perspective. */
    heldObjectMesh: null,
    /** Type of the held object: 'block' or 'player'. */
    heldObjectType: null,
    /** If holding a player, their player ID. */
    heldPlayerId: null,
    /** If holding a player, their capsule mesh reference. */
    heldObjectCapsule: null,
    /** Original offset from foot to capsule centre (used to convert positions). */
    heldObjectOriginalOffsetY: 0,
    /** Relative rotation of the held object with respect to the camera. */
    holdRelativeRotation: new THREE.Quaternion(),
    /** The scale at which the object was picked up (used for perspective scaling). */
    holdLockedScale: 1.0,
    /** The distance from camera to object at pickup (used for perspective scaling). */
    holdLockedDistance: 0,
    /** Half‑extents of the held object (computed from its bounding box). */
    holdLockedHalfExtents: new THREE.Vector3(0.5, 0.5, 0.5),

    // Rod pickup (Q) hold
    /** Whether the rod pickup (Q) is active. */
    rodPickupActive: false,

    // ---------- Raycaster & crosshair ----------
    /** Reusable raycaster for hover and interaction checks. */
    raycaster: new THREE.Raycaster(),
    /** DOM element for the crosshair (used to change colour on hover). */
    crosshair: document.getElementById('crosshair'),
    /** The currently hovered object (for visual feedback). */
    hoveredObject: null,

    // ---------- Remote players ----------
    /** Map from player ID to remote player data (avatars, capsules, animations). */
    remotePlayers: new Map(),

    // ---------- Local player state from worker ----------
    /** The most recent state of the local player received from the worker. */
    localPlayerState: null,

    // ---------- Input state ----------
    /** Keyboard state for movement and jump (WASD and Space). */
    keyState: { w: false, a: false, s: false, d: false, space: false },
    /** Current yaw (horizontal rotation) in radians. */
    rawYaw: 0,
    /** Current pitch (vertical rotation) in radians, clamped to ±π/2. */
    pitch: 0,

    // ---------- Portal teleport sync (sequence number and frame cooldown) ----------
    /** Last teleport sequence number received from the worker (to reject stale inputs). */
    teleportSeq: 0,
    /** Number of world_state messages to ignore for local player updates after a teleport. */
    skipWorldStateFrames: 0,
    /** Forced position from teleport sync (applied during cooldown). */
    syncedModelPosition: null,
    /** Forced quaternion from teleport sync. */
    syncedModelQuaternion: null,
    /** Forced scale from teleport sync. */
    syncedModelScale: 1,

    // ---------- Split‑phase portal camera (detached mode) ----------
    /** True when camera is on the exit side while the body is still on the entrance side. */
    cameraDetached: false,
    /** Reference to the entrance portal for the current detachment. */
    detachEntrancePortal: null,
    /** Reference to the exit portal for the current detachment. */
    detachExitPortal: null,
    /** Matrix4 that maps entrance world space to exit world space (used for camera transform). */
    detachTransformMatrix: null,
};