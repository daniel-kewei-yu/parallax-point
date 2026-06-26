/*
Author: Daniel Yu
Date: March 15, 2026
Description: Builds the static world geometry for the game. This includes the floor, walls, ceiling,
             platforms, ring walls, pillars, a grid helper, and an axis helper for debugging.
             The grid helper is rendered with depthWrite false, LEQUAL depth test, and polygon offset
             to permanently eliminate z-fighting with the floor. All geometry uses standard Three.js
             meshes with shadow support.
*/

// Import Three.js core for geometries, materials, and vector operations.
import * as THREE from 'three';
// Import the global game state to access the scene.
import { GameState } from '../clientState.js';
// Import client configuration constants (room size, wall height, etc.).
import { CLIENT_CONFIG } from '../clientConfig.js';

/**
 * Builds and adds all static world geometry to the scene. This includes:
 * - Floor plane
 * - Four outer walls
 * - Ceiling
 * - Four elevated platforms (two long, two wide)
 * - Ring walls forming a circle of segments
 * - Pillars at specified positions
 * - A grid helper on the floor with z-fighting fixes
 * - Axis helper (arrows and labels) for debugging orientation
 * @param {void} - No parameters.
 * @returns {void}
 */
export function buildWorld() {
    // ----- Materials -----
    // Wall material: dark grey-blue with slight metalness.
    const wallMaterial = new THREE.MeshStandardMaterial({
        color: 0x2a2a3a,
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide, // Render both sides to avoid backface culling issues.
    });

    // Floor material: slightly lighter, matte finish.
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: 0x2a2a3a,
        roughness: 0.7,
        side: THREE.DoubleSide,
    });

    // Platform material: a blue-grey with slight metallic sheen.
    const platformMaterial = new THREE.MeshStandardMaterial({
        color: 0x5a6e8e,
        roughness: 0.5,
        metalness: 0.2,
        side: THREE.DoubleSide,
    });

    // ----- Floor -----
    // Create a large plane geometry for the floor, spanning the entire room.
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(CLIENT_CONFIG.ROOM_SIZE * 2, CLIENT_CONFIG.ROOM_SIZE * 2),
        floorMaterial
    );
    // Rotate the plane to be horizontal (lying flat on the ground).
    floor.rotation.x = -Math.PI / 2;
    // Position it at y = 0 (ground level).
    floor.position.y = 0;
    // Enable receiving shadows so objects cast shadows onto the floor.
    floor.receiveShadow = true;
    // Add the floor to the scene.
    GameState.scene.add(floor);

    /**
     * Helper function to create a wall (or any box-shaped object).
     * @param {number} width - Width along the local X axis.
     * @param {number} height - Height along the local Y axis.
     * @param {number} depth - Depth along the local Z axis.
     * @param {THREE.Vector3} pos - Position in world space.
     * @param {THREE.Vector3} rot - Euler rotation in radians.
     * @returns {THREE.Mesh} The created mesh.
     */
    function createWall(width, height, depth, pos, rot) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), wallMaterial);
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.rotation.set(rot.x, rot.y, rot.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        GameState.scene.add(mesh);
        return mesh;
    }

    // ----- Outer walls -----
    // Back wall (z = -ROOM_SIZE)
    createWall(CLIENT_CONFIG.ROOM_SIZE * 2, CLIENT_CONFIG.WALL_HEIGHT, CLIENT_CONFIG.WALL_THICKNESS,
        new THREE.Vector3(0, CLIENT_CONFIG.WALL_HEIGHT / 2, -CLIENT_CONFIG.ROOM_SIZE), new THREE.Vector3(0, 0, 0));
    // Front wall (z = ROOM_SIZE)
    createWall(CLIENT_CONFIG.ROOM_SIZE * 2, CLIENT_CONFIG.WALL_HEIGHT, CLIENT_CONFIG.WALL_THICKNESS,
        new THREE.Vector3(0, CLIENT_CONFIG.WALL_HEIGHT / 2, CLIENT_CONFIG.ROOM_SIZE), new THREE.Vector3(0, 0, 0));
    // Left wall (x = -ROOM_SIZE)
    createWall(CLIENT_CONFIG.WALL_THICKNESS, CLIENT_CONFIG.WALL_HEIGHT, CLIENT_CONFIG.ROOM_SIZE * 2,
        new THREE.Vector3(-CLIENT_CONFIG.ROOM_SIZE, CLIENT_CONFIG.WALL_HEIGHT / 2, 0), new THREE.Vector3(0, 0, 0));
    // Right wall (x = ROOM_SIZE)
    createWall(CLIENT_CONFIG.WALL_THICKNESS, CLIENT_CONFIG.WALL_HEIGHT, CLIENT_CONFIG.ROOM_SIZE * 2,
        new THREE.Vector3(CLIENT_CONFIG.ROOM_SIZE, CLIENT_CONFIG.WALL_HEIGHT / 2, 0), new THREE.Vector3(0, 0, 0));

    // ----- Ceiling -----
    // A thin box at the top of the walls, covering the entire room.
    createWall(CLIENT_CONFIG.ROOM_SIZE * 2, CLIENT_CONFIG.WALL_THICKNESS, CLIENT_CONFIG.ROOM_SIZE * 2,
        new THREE.Vector3(0, CLIENT_CONFIG.WALL_HEIGHT, 0), new THREE.Vector3(0, 0, 0));

    /**
     * Helper function to add a platform (a flat box) to the scene.
     * @param {number} width - Width along X.
     * @param {number} height - Height (thickness).
     * @param {number} depth - Depth along Z.
     * @param {Object} pos - {x, y, z} position.
     * @returns {void}
     */
    function addPlatform(width, height, depth, pos) {
        const platform = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), platformMaterial);
        platform.position.set(pos.x, pos.y, pos.z);
        platform.castShadow = true;
        platform.receiveShadow = true;
        GameState.scene.add(platform);
    }

    // ----- Platforms (elevated surfaces) -----
    const platformHeight = 1;        // Thickness of each platform.
    const platformY = 3;             // Height above the floor.

    // Left and right platforms: long along X (width 11), shorter along Z (depth 20).
    addPlatform(11, platformHeight, 20, { x: -25, y: platformY, z: 0 });
    addPlatform(11, platformHeight, 20, { x: 25, y: platformY, z: 0 });

    // Front and back platforms: long along Z (width 20), shorter along X (depth 11).
    addPlatform(20, platformHeight, 11, { x: 0, y: platformY, z: -25 });
    addPlatform(20, platformHeight, 11, { x: 0, y: platformY, z: 25 });

    // ----- Ring walls (a circular arrangement of wall segments) -----
    const ringRadius = 31;           // Radius of the ring (distance from centre to wall centre).
    const ringHeight = 5;            // Height of each wall segment.
    const ringThickness = 2;         // Thickness of each wall segment (radial direction).
    const ringSegments = 16;         // Number of segments around the circle.

    for (let i = 0; i < ringSegments; i++) {
        // Compute the angle for this segment.
        const angle = (i / ringSegments) * Math.PI * 2;
        // Compute the position on the circle.
        const x = Math.cos(angle) * ringRadius;
        const z = Math.sin(angle) * ringRadius;

        // Create a wall segment: width (tangential) = 10, height = ringHeight, depth (radial) = ringThickness.
        const wall = new THREE.Mesh(new THREE.BoxGeometry(10, ringHeight, ringThickness), wallMaterial);
        wall.position.set(x, ringHeight / 2, z);
        // Orient the wall so its local Z axis points toward the centre (like lookAt).
        wall.lookAt(0, ringHeight / 2, 0);
        wall.castShadow = true;
        wall.receiveShadow = true;
        GameState.scene.add(wall);
    }

    // ----- Pillars -----
    const pillarHeight = 6;
    const pillarY = 3;               // Centre height of pillars.
    const pillarSize = 1.5;          // Width and depth of each pillar (square cross-section).

    // Positions of pillars in the room (x, y, z) with y=0 meaning they are at ground level.
    const pillarPositions = [
        [-10, 0, -20], [10, 0, -20], [-10, 0, 20], [10, 0, 20],
        [-20, 0, -10], [20, 0, -10], [-20, 0, 10], [20, 0, 10]
    ];
    // Iterate over each position and add a pillar.
    pillarPositions.forEach(pos => {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(pillarSize, pillarHeight, pillarSize), platformMaterial);
        pillar.position.set(pos[0], pillarY, pos[2]);
        pillar.castShadow = true;
        pillar.receiveShadow = true;
        GameState.scene.add(pillar);
    });

    // ----- Grid helper (for visual reference on the floor) -----
    // Create a grid helper spanning the room, with 40 divisions.
    const gridHelper = new THREE.GridHelper(CLIENT_CONFIG.ROOM_SIZE * 2, 40, 0xffaa00, 0x335588);
    // Raise it slightly above the floor to avoid z-fighting with the floor plane.
    gridHelper.position.y = 0.0005;

    // Apply permanent fixes to the grid materials to eliminate z-fighting:
    // - depthWrite false so it never modifies the depth buffer.
    // - depthFunc LEQUAL so it passes when depth is equal to the floor.
    // - polygonOffset with a small negative value to make it slightly closer.
    // The grid helper uses either a single material or an array (for lines and centre lines).
    if (Array.isArray(gridHelper.material)) {
        gridHelper.material.forEach(mat => {
            if (mat.isMaterial) {
                mat.depthTest = true;
                mat.depthFunc = THREE.LequalDepth;   // LEQUAL (0x0203)
                mat.depthWrite = false;
                mat.polygonOffset = true;
                mat.polygonOffsetFactor = 0;
                mat.polygonOffsetUnits = -1;         // Pull the grid slightly forward.
                mat.needsUpdate = true;
            }
        });
    } else if (gridHelper.material) {
        gridHelper.material.depthTest = true;
        gridHelper.material.depthFunc = THREE.LequalDepth;
        gridHelper.material.depthWrite = false;
        gridHelper.material.polygonOffset = true;
        gridHelper.material.polygonOffsetFactor = 0;
        gridHelper.material.polygonOffsetUnits = -1;
        gridHelper.material.needsUpdate = true;
    }
    // Add the grid helper to the scene.
    GameState.scene.add(gridHelper);

    // Add axis helper (debugging) to show the coordinate system orientation.
    addAxisHelper(GameState.scene);
}

/**
 * Adds an axis helper to the scene: red X, green Y, blue Z arrows with labels.
 * Also adds a small white sphere at the origin.
 * @param {THREE.Scene} scene - The scene to add the axis helper to.
 * @returns {void}
 */
function addAxisHelper(scene) {
    // Origin point.
    const origin = new THREE.Vector3(0, 0, 0);
    const length = 3.0;         // Length of each arrow.
    const headLength = 0.3;     // Arrow head length.
    const headWidth = 0.2;      // Arrow head width.

    // Add arrows for X, Y, Z axes.
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), origin, length, 0xff3333, headLength, headWidth));
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), origin, length, 0x33ff33, headLength, headWidth));
    scene.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), origin, length, 0x3388ff, headLength, headWidth));

    /**
     * Creates a sprite label for an axis with the given text and colour.
     * The label is rendered on a canvas and used as a texture.
     * @param {string} text - The label text (e.g., 'X').
     * @param {string} color - CSS colour string (e.g., '#ff6666').
     * @returns {THREE.Sprite} The sprite label.
     */
    function createAxisLabel(text, color) {
        // Create a canvas to draw the text.
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = 'Bold 48px Arial';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 32, 32);
        // Create a texture from the canvas.
        const texture = new THREE.CanvasTexture(canvas);
        // Create a sprite with the texture.
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
        sprite.scale.set(0.8, 0.8, 1);
        return sprite;
    }

    // Create and position labels for each axis.
    const labelX = createAxisLabel('X', '#ff6666');
    labelX.position.set(length + 0.5, 0.2, 0);
    scene.add(labelX);

    const labelY = createAxisLabel('Y', '#66ff66');
    labelY.position.set(0, length + 0.5, 0);
    scene.add(labelY);

    const labelZ = createAxisLabel('Z', '#6688ff');
    labelZ.position.set(0, 0, length + 0.5);
    scene.add(labelZ);

    // Add a small white sphere at the origin for reference.
    const sphereGeo = new THREE.SphereGeometry(0.08);
    const sphereMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 });
    const originSphere = new THREE.Mesh(sphereGeo, sphereMat);
    originSphere.position.copy(origin);
    scene.add(originSphere);
}