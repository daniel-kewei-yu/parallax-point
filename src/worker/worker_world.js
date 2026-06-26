/*
Author: Daniel Yu
Date: March 15, 2026
Description: Creates the static physics world (floor, walls, ceiling, platforms,
             pillars, ring walls) using Cannon.js. All bodies are static (mass = 0)
             and use the block material. The world is built once when the worker starts.
             This version matches the visual geometry in worldGeometry.js exactly.
*/

import * as CANNON from 'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js';
import { world, blockMaterial } from './physicsSharedWorker.js';
import { CONFIG } from './worker_config.js';

export function buildWorld() {
    // Floor (thick box)
    const floorShape = new CANNON.Box(new CANNON.Vec3(CONFIG.ROOM_SIZE, 0.5, CONFIG.ROOM_SIZE));
    const floorBody = new CANNON.Body({ mass: 0, material: blockMaterial });
    floorBody.addShape(floorShape);
    floorBody.position.set(0, -0.5, 0);
    world.addBody(floorBody);

    function addBox(width, height, depth, pos) {
        const shape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
        const body = new CANNON.Body({ mass: 0, material: blockMaterial });
        body.addShape(shape);
        body.position.set(pos.x, pos.y, pos.z);
        world.addBody(body);
    }

    // Outer walls (same as visual)
    addBox(CONFIG.ROOM_SIZE * 2, CONFIG.WALL_HEIGHT, CONFIG.WALL_THICKNESS, { x: 0, y: CONFIG.WALL_HEIGHT / 2, z: -CONFIG.ROOM_SIZE });
    addBox(CONFIG.ROOM_SIZE * 2, CONFIG.WALL_HEIGHT, CONFIG.WALL_THICKNESS, { x: 0, y: CONFIG.WALL_HEIGHT / 2, z: CONFIG.ROOM_SIZE });
    addBox(CONFIG.WALL_THICKNESS, CONFIG.WALL_HEIGHT, CONFIG.ROOM_SIZE * 2, { x: -CONFIG.ROOM_SIZE, y: CONFIG.WALL_HEIGHT / 2, z: 0 });
    addBox(CONFIG.WALL_THICKNESS, CONFIG.WALL_HEIGHT, CONFIG.ROOM_SIZE * 2, { x: CONFIG.ROOM_SIZE, y: CONFIG.WALL_HEIGHT / 2, z: 0 });

    // Ceiling – matches visual: at y = CONFIG.WALL_HEIGHT (not *2)
    addBox(CONFIG.ROOM_SIZE * 2, CONFIG.WALL_THICKNESS, CONFIG.ROOM_SIZE * 2, { x: 0, y: CONFIG.WALL_HEIGHT, z: 0 });

    // ------------------------------------------------------------------
    // Platforms – match visual dimensions (11x1x20 and 20x1x11)
    // ------------------------------------------------------------------
    const platformHeight = 1;
    const platformY = 3;
    // Left platform: width 11, depth 20
    addBox(11, platformHeight, 20, { x: -25, y: platformY, z: 0 });
    // Right platform: width 11, depth 20
    addBox(11, platformHeight, 20, { x: 25, y: platformY, z: 0 });
    // Front platform: width 20, depth 11
    addBox(20, platformHeight, 11, { x: 0, y: platformY, z: -25 });
    // Back platform: width 20, depth 11
    addBox(20, platformHeight, 11, { x: 0, y: platformY, z: 25 });

    // ------------------------------------------------------------------
    // Ring walls – match visual ring walls exactly
    // ------------------------------------------------------------------
    const ringRadius = 31;
    const ringHeight = 5;
    const ringThickness = 2;
    const ringSegments = 16;

    for (let i = 0; i < ringSegments; i++) {
        const angle = (i / ringSegments) * Math.PI * 2;
        const x = Math.cos(angle) * ringRadius;
        const z = Math.sin(angle) * ringRadius;

        // Half-extents: width (tangential) = 10, height = 5, depth (radial) = 2
        const shape = new CANNON.Box(new CANNON.Vec3(5, ringHeight / 2, ringThickness / 2));
        const body = new CANNON.Body({ mass: 0, material: blockMaterial });
        body.addShape(shape);
        body.position.set(x, ringHeight / 2, z);

        // Rotate so that local Z points toward center (like visual lookAt)
        const rotationAngle = Math.atan2(-x, -z);
        const quat = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), rotationAngle);
        body.quaternion.copy(quat);
        world.addBody(body);
    }

    // ------------------------------------------------------------------
    // Pillars – match visual positions and dimensions
    // ------------------------------------------------------------------
    const pillarHeight = 6;
    const pillarY = 3;
    const pillarSize = 1.5;
    const pillarPositions = [
        [-10, 0, -20], [10, 0, -20], [-10, 0, 20], [10, 0, 20],
        [-20, 0, -10], [20, 0, -10], [-20, 0, 10], [20, 0, 10]
    ];
    pillarPositions.forEach(pos => {
        addBox(pillarSize, pillarHeight, pillarSize, { x: pos[0], y: pillarY, z: pos[2] });
    });
}