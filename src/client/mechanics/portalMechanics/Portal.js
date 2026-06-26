/*
Author: Daniel Yu
Date: April 24, 2026
Description: Defines the Portal class, which represents a single portal mesh in the scene.
             Each portal consists of a semi-transparent disc (with emissive glow) and a glowing
             ring border. The disc scale is slightly elliptical (0.8 x 1.2) to give a stylized look.
             The portal stores its position, rotation, forward direction, and a THREE.Plane for
             distance calculations and clipping. The mesh is tagged with userData for identification
             during raycasting and rendering.
*/

// Import the Three.js core library for geometry, materials, and vector/quaternion operations.
import * as THREE from 'three';

/**
 * Represents a portal mesh with a disc and a ring border.
 * Portals are placed on surfaces and can be paired (blue/orange) to enable teleportation.
 */
export class Portal {
    /**
     * Constructs a new Portal instance.
     * @param {string} id - Unique identifier for this portal.
     * @param {string} type - The portal type: 'blue' or 'orange'.
     * @param {THREE.Vector3} position - World-space position of the portal centre.
     * @param {THREE.Quaternion} rotation - Orientation of the portal (local Z points outward from the surface).
     */
    constructor(id, type, position, rotation) {
        // Store the unique identifier.
        this.id = id;

        // Store the portal type ('blue' or 'orange').
        this.type = type;

        // Clone the input position and rotation to avoid external mutations.
        this.position = position.clone();
        this.rotation = rotation.clone();

        // Compute the portal's forward direction (local Z axis) in world space.
        // This vector points outward from the surface the portal is placed on.
        this.forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.rotation).normalize();

        // Create a THREE.Plane from the forward direction and the portal position.
        // The plane's normal is the forward vector, and it passes through the portal centre.
        // This plane is used for distance calculations, clipping, and intersection tests.
        this.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.forward, this.position);

        // Build the visual meshes (disc and ring) and store references.
        const { group, disc, ring } = this.createMeshes();

        // Store the root group as the portal's main mesh.
        this.mesh = group;

        // Store references to the disc and ring meshes for later manipulation (e.g., visibility, material changes).
        this.discMesh = disc;
        this.ringMesh = ring;

        // Tag the root group with userData for identification in raycasts and scene traversal.
        this.mesh.userData.isPortal = true;      // Marks this object as a portal.
        this.mesh.userData.portalId = this.id;   // Stores the portal's unique ID.
        this.mesh.userData.portalType = this.type; // Stores the portal type.
    }

    /**
     * Creates the visual representation of the portal: a disc (with emissive material) and a ring border.
     * The disc is scaled to 0.8 on X and 1.2 on Y for a slightly elliptical look.
     * The ring uses a RingGeometry with a small thickness to create a glowing border.
     * @returns {Object} An object containing the root group, the disc mesh, and the ring mesh.
     */
    createMeshes() {
        // Create a root group to hold both the disc and the ring.
        const group = new THREE.Group();

        // ----- Portal Disc -----
        // Create a circle geometry with radius 1.25 and 48 segments for smoothness.
        const discGeometry = new THREE.CircleGeometry(1.25, 48);

        // Create a standard material with emissive properties to make the portal glow.
        const discMaterial = new THREE.MeshStandardMaterial({
            // Color depends on portal type: blue for 'blue', orange for 'orange'.
            color: this.type === 'blue' ? 0x3399ff : 0xff9933,
            // Emissive color is a darker tone of the main color for a subtle glow.
            emissive: this.type === 'blue' ? 0x004466 : 0x442200,
            // Intensity of the emissive glow.
            emissiveIntensity: 1.4,
            // Slight metalness and roughness to give the disc a polished look.
            metalness: 0.3,
            roughness: 0.4,
            // Render both sides so the disc is visible from any angle.
            side: THREE.DoubleSide,
            // Disable transparency to avoid sorting issues with the stencil buffer.
            transparent: false,
            // Write to depth buffer to allow proper occlusion.
            depthWrite: true,
            // Enable depth testing for correct z-ordering.
            depthTest: true,
        });

        // Create the disc mesh from the geometry and material.
        const disc = new THREE.Mesh(discGeometry, discMaterial);

        // Scale the disc to be slightly wider than tall (stylised elliptical portal).
        disc.scale.set(0.8, 1.2, 0.8);

        // Tag the disc mesh as a portal part (for identification).
        disc.userData.isPortal = true;

        // Add the disc to the root group.
        group.add(disc);

        // ----- Glowing Border Ring -----
        // The ring sits just outside the disc to give a glowing edge.
        const innerRadius = 1.25;   // Matches the disc radius before scaling.
        const outerRadius = 1.3;    // Slightly larger to create the ring thickness.
        const ringGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 64);

        // Use a basic material for the ring (no lighting, pure colour) so it always appears bright.
        const ringMaterial = new THREE.MeshBasicMaterial({
            // Colour matches the portal type: blue or orange.
            color: this.type === 'blue' ? 0x44aaff : 0xffaa44,
            // Render both sides for visibility.
            side: THREE.DoubleSide,
            // Write to depth buffer to prevent z-fighting with the disc.
            depthWrite: true,
            // Enable depth testing.
            depthTest: true,
            // Make the ring fully opaque.
            transparent: false,
            opacity: 1.0,
        });

        // Create the ring mesh.
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);

        // Apply the same elliptical scale to the ring so it matches the disc's proportions.
        ring.scale.set(0.8, 1.2, 0.8);

        // Tag the ring mesh as a portal part.
        ring.userData.isPortal = true;

        // Add the ring to the root group.
        group.add(ring);

        // Position and orient the entire group using the stored position and rotation.
        group.position.copy(this.position);
        group.quaternion.copy(this.rotation);

        // Disable shadow casting/receiving for portals to improve performance.
        group.castShadow = false;
        group.receiveShadow = false;

        // Set a higher render order so portals are drawn after most geometry.
        // This helps with stencil buffer rendering and avoids depth conflicts.
        group.renderOrder = 1;

        // Return the group and the individual meshes for external reference.
        return { group, disc, ring };
    }

    /**
     * Updates the portal's position and rotation in world space.
     * This also recomputes the forward direction and the clipping plane.
     * @param {THREE.Vector3} position - New world-space position.
     * @param {THREE.Quaternion} rotation - New orientation.
     * @returns {void}
     */
    updateTransform(position, rotation) {
        // Update the stored position and rotation.
        this.position.copy(position);
        this.rotation.copy(rotation);

        // Recompute the forward direction (local Z) in world space.
        this.forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.rotation).normalize();

        // Rebuild the THREE.Plane from the new normal and position.
        this.plane.setFromNormalAndCoplanarPoint(this.forward, this.position);

        // If the root mesh exists, update its transform to match the new values.
        if (this.mesh) {
            this.mesh.position.copy(this.position);
            this.mesh.quaternion.copy(this.rotation);
        }
    }

    /**
     * Computes the signed distance from a point to the portal's plane.
     * Positive values indicate the point is in front of the portal (in the direction of the forward vector).
     * Negative values indicate the point is behind the portal.
     * @param {THREE.Vector3} point - World-space point.
     * @returns {number} Signed distance from the point to the portal plane.
     */
    signedDistance(point) {
        return this.plane.distanceToPoint(point);
    }

    /**
     * Checks whether a given axis-aligned bounding box (AABB) intersects the portal's plane.
     * This is used for quick broad-phase rejection before performing detailed portal crossing checks.
     * @param {THREE.Box3} box - The bounding box to test.
     * @returns {boolean} True if the plane intersects the box, false otherwise.
     */
    intersectsBox(box) {
        return this.plane.intersectsBox(box);
    }
}