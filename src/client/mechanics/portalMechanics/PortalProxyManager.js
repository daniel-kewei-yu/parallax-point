/*
Author: Daniel Yu
Date: June 9, 2026
Description: Manages visual proxies (clones) for objects that intersect portals. When an object (player, block, remote player)
             is near a portal, this module creates a clone on the exit side, applies clipping planes to both the original
             and the clone (using elliptic cylinder + plane clipping), and updates the clone's transform each frame to match
             the portal‑pair perspective. Supports both skinned meshes (with SkeletonUtils.clone and bone mapping) and
             generic meshes. The proxies enable seamless visual teleportation without duplicating physics.
*/

// Import Three.js core and utilities.
import * as THREE from 'three';
// Import SkeletonUtils for cloning skinned meshes with bone hierarchies.
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';
// Import the global game state to access the scene and configuration.
import { GameState } from '../../clientState.js';
// Import client configuration (player radius for proximity checks).
import { CLIENT_CONFIG } from '../../clientConfig.js';

/**
 * Singleton object that manages all active portal proxies.
 * It stores a map of entityId -> proxy data, and provides methods to start, update, and stop proxies.
 */
export const PortalProxyManager = {
    /**
     * Map from entity ID (e.g., 'player_p_5', 'block_abc123') to proxy data.
     * Each entry stores: { originalMesh, cloneMesh, entrancePortal, exitPortal, crossedFraction, boneMap, backSide }
     * @type {Map<string, Object>}
     */
    activeProxies: new Map(),

    /**
     * Reference to the Three.js scene where clones are added and removed.
     * @type {THREE.Scene|null}
     */
    scene: null,

    /**
     * Flag indicating whether the manager has been initialised.
     * @type {boolean}
     */
    initialized: false,

    /**
     * Initialises the proxy manager with the scene reference.
     * Must be called before any proxy operations.
     * @param {THREE.Scene} scene - The main scene to add/remove clone meshes.
     * @returns {void}
     */
    init(scene) {
        this.scene = scene;
        this.initialized = true;
    },

    /**
     * Computes a transformation matrix that maps positions from the entrance portal's local space
     * to the exit portal's local space, including a 180-degree rotation around Y (to mirror the view).
     * This matrix is used to transform the original object's position and rotation to the clone's position and rotation.
     * @param {Portal} entrancePortal - The portal the object is intersecting.
     * @param {Portal} exitPortal - The paired portal where the clone should appear.
     * @returns {THREE.Matrix4} The 4x4 transformation matrix.
     */
    _portalPairMatrix(entrancePortal, exitPortal) {
        // Build a 4x4 matrix from the entrance portal's position and rotation.
        const entranceMat = new THREE.Matrix4().compose(
            entrancePortal.position, entrancePortal.rotation, new THREE.Vector3(1, 1, 1)
        );
        // Build a 4x4 matrix from the exit portal's position and rotation.
        const exitMat = new THREE.Matrix4().compose(
            exitPortal.position, exitPortal.rotation, new THREE.Vector3(1, 1, 1)
        );
        // Create a matrix representing a 180-degree rotation around the Y axis (to mirror across the portal).
        const rotationYMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
        // Invert the entrance matrix to go from world space to entrance local space.
        const invEntranceMat = entranceMat.clone().invert();
        // Combine: exitMat * rotationY * invEntranceMat.
        // This maps: world -> entrance local -> mirror (rotate Y 180) -> exit world.
        return new THREE.Matrix4().multiplyMatrices(exitMat, rotationYMatrix).multiply(invEntranceMat);
    },

    /**
     * Generates an array of clipping planes that approximate an elliptic cylinder around the portal disc.
     * These planes, together with the portal plane, clip the original and clone meshes so they appear
     * correctly cut at the portal boundary. The planes are tangent to the ellipse.
     * @param {Portal} portal - The portal whose ellipse defines the clipping boundary.
     * @param {boolean} outward - If true, normals point outward (for clipping the original); if false, inward (for the clone).
     * @returns {THREE.Plane[]} An array of clipping planes.
     */
    _generateEllipsePlanes(portal, outward = false) {
        // Get the disc mesh to access its scale (set in Portal.createMeshes).
        const disc = portal.discMesh;
        // Base radius of the portal disc (set in Portal constructor).
        const baseRadius = 1.3;
        // Compute the actual radii of the ellipse in world space.
        const rx = baseRadius * disc.scale.x; // typically 0.8 => 1.04
        const ry = baseRadius * disc.scale.y; // typically 1.2 => 1.56
        // The centre of the portal.
        const center = portal.position;
        // Compute the right and up vectors of the portal in world space (local X and Y axes).
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(portal.rotation).normalize();
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(portal.rotation).normalize();
        // The forward vector (normal to the portal plane).
        const forward = portal.forward;

        // Array to store the generated planes.
        const planes = [];
        // Number of segments around the ellipse.
        const steps = 24;

        // For each step, compute a point on the ellipse boundary and a tangent, then derive a plane.
        for (let i = 0; i < steps; i++) {
            // Angle around the ellipse (0 to 2PI).
            const angle = (i / steps) * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            // Local coordinates on the ellipse (before rotation).
            const localX = rx * cos;
            const localY = ry * sin;

            // World-space point on the ellipse boundary.
            const boundaryPoint = center.clone()
                .add(right.clone().multiplyScalar(localX))
                .add(up.clone().multiplyScalar(localY));

            // Tangent vector at this point (derivative of the ellipse equation).
            const tangent = right.clone().multiplyScalar(-rx * sin)
                .add(up.clone().multiplyScalar(ry * cos))
                .normalize();

            // The plane normal is perpendicular to the tangent and the forward direction.
            let normal = tangent.clone().cross(forward).normalize();
            // Ensure the normal points towards the centre of the ellipse (so the clip volume is on the inside).
            const toCenter = center.clone().sub(boundaryPoint).normalize();
            if (normal.dot(toCenter) < 0) normal.negate();
            // If outward is true, flip the normal to clip the original object (keep outside).
            if (outward) normal.negate();

            // Create a plane from the normal and the boundary point.
            const plane = new THREE.Plane(normal, 0);
            plane.setFromNormalAndCoplanarPoint(normal, boundaryPoint);
            planes.push(plane);
        }
        return planes;
    },

    /**
     * Applies clipping planes to the original mesh (the one intersecting the portal).
     * The clipping is set to intersection mode (clipIntersection = true) so that the mesh
     * is only visible where it is inside the elliptic cylinder and on the correct side of the portal plane.
     * @param {THREE.Object3D} obj - The original mesh (or group) to clip.
     * @param {Portal} portal - The entrance portal.
     * @param {boolean} backSide - Whether the object is on the back side of the portal (signedDist < 0).
     * @param {boolean} useElliptic - If true, use elliptic planes; if false, use only the portal plane.
     * @returns {void}
     */
    _setOriginalClipping(obj, portal, backSide, useElliptic) {
        // Start with the portal plane. If the object is on the back side, negate the plane to keep the visible portion.
        let portalPlane = portal.plane;
        if (backSide) portalPlane = portalPlane.clone().negate();

        // Build the full set of clipping planes.
        let planes;
        if (useElliptic) {
            // Generate elliptic planes with outward normals (to clip the outside of the ellipse).
            const ellipsePlanes = this._generateEllipsePlanes(portal, true);
            // Combine ellipse planes and the portal plane.
            planes = [...ellipsePlanes, portalPlane];
        } else {
            // Only the portal plane (simpler clipping, used when the object has fully crossed).
            planes = [portalPlane];
        }

        // Traverse the object and apply the clipping planes to all mesh materials.
        obj.traverse((child) => {
            if (child.isMesh && child.material) {
                // Handle both single material and array of materials.
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(mat => {
                    if (!mat || !mat.isMaterial) return;
                    // Set the clipping planes.
                    mat.clippingPlanes = planes;
                    // Intersection mode: the mesh is rendered only where it satisfies ALL clipping planes.
                    mat.clipIntersection = true;
                    // Also clip shadows.
                    mat.clipShadows = true;
                    // Mark the material as needing update.
                    mat.needsUpdate = true;
                });
            }
        });
    },

    /**
     * Applies clipping planes to the clone mesh (the one on the exit side).
     * The clipping is set to union mode (clipIntersection = false) so that the mesh is visible
     * where it is NOT outside the elliptic cylinder and on the correct side of the exit portal plane.
     * @param {THREE.Object3D} obj - The clone mesh (or group) to clip.
     * @param {Portal} portal - The exit portal.
     * @param {boolean} backSide - Whether the original object is on the back side (determines which side of the exit plane to keep).
     * @param {boolean} useElliptic - If true, use elliptic planes; if false, use only the portal plane.
     * @returns {void}
     */
    _setCloneClipping(obj, portal, backSide, useElliptic) {
        // Start with the exit portal plane. If the original is on the back side, we want to keep the opposite side.
        let exitPlane = portal.plane;
        if (backSide) exitPlane = exitPlane.clone().negate();

        let planes;
        if (useElliptic) {
            // Generate elliptic planes with inward normals (to keep the inside of the ellipse).
            const ellipsePlanes = this._generateEllipsePlanes(portal, false);
            planes = [...ellipsePlanes, exitPlane];
        } else {
            planes = [exitPlane];
        }

        // Traverse and apply planes.
        obj.traverse((child) => {
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(mat => {
                    if (!mat || !mat.isMaterial) return;
                    mat.clippingPlanes = planes;
                    // Union mode: the mesh is visible if it satisfies ANY of the planes (i.e., not outside).
                    mat.clipIntersection = false;
                    mat.clipShadows = true;
                    mat.needsUpdate = true;
                });
            }
        });
    },

    /**
     * Removes all clipping planes from an object, restoring its original appearance.
     * Called when the proxy is stopped.
     * @param {THREE.Object3D} obj - The object to clear clipping from.
     * @returns {void}
     */
    _clearClipping(obj) {
        obj.traverse((child) => {
            if (child.isMesh && child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach(mat => {
                    if (!mat || !mat.isMaterial) return;
                    // Reset clipping planes to an empty array.
                    mat.clippingPlanes = [];
                    mat.clipIntersection = false;
                    mat.clipShadows = false;
                    mat.needsUpdate = true;
                });
            }
        });
    },

    /**
     * Starts a proxy for the given entity. Creates a clone of the original mesh,
     * applies clipping to both original and clone, and adds the clone to the scene.
     * Supports both skinned meshes (with bones) and generic meshes.
     * @param {string} entityId - Unique entity ID.
     * @param {THREE.Object3D} originalMesh - The original mesh/group to clone.
     * @param {Portal} entrancePortal - The portal the entity is intersecting.
     * @param {Portal} exitPortal - The paired exit portal.
     * @param {number} crossedFraction - How much of the entity has crossed (0-1), currently unused but kept for future.
     * @returns {void}
     */
    startProxy(entityId, originalMesh, entrancePortal, exitPortal, crossedFraction) {
        // Guard: ensure the manager is initialised.
        if (!this.initialized) return;
        // If a proxy already exists for this entity, don't create a new one.
        if (this.activeProxies.has(entityId)) return;

        // Determine if the mesh has bones (skinned mesh).
        let hasBones = false;
        originalMesh.traverse(child => { if (child.isBone) hasBones = true; });

        // Variables for the clone and bone mapping.
        let cloneMesh;
        let boneMap = null;

        if (hasBones) {
            // ----- Skinned mesh: use SkeletonUtils.clone to duplicate the entire skeleton and skin.
            cloneMesh = SkeletonUtils.clone(originalMesh);
            // Tag the clone with the entity ID for identification.
            cloneMesh.userData = { proxyEntityId: entityId };

            // Deep‑clone all materials so the clone has its own material instances (important for clipping).
            cloneMesh.traverse((child) => {
                if (child.isMesh && child.material) {
                    if (Array.isArray(child.material)) {
                        child.material = child.material.map(mat => mat ? mat.clone() : null).filter(Boolean);
                    } else {
                        child.material = child.material.clone();
                    }
                    // Ensure skinned meshes retain their skinning flag.
                    if (child.isSkinnedMesh) child.material.skinning = true;
                }
            });

            // Build a mapping from original bone to clone bone (by name) to synchronise animations later.
            const cloneBonesByName = new Map();
            cloneMesh.traverse(c => { if (c.isBone) cloneBonesByName.set(c.name, c); });
            boneMap = new Map();
            originalMesh.traverse(o => {
                if (o.isBone && cloneBonesByName.has(o.name)) {
                    boneMap.set(o, cloneBonesByName.get(o.name));
                }
            });
            // Initially copy bone transforms from original to clone.
            boneMap.forEach((cloneBone, origBone) => {
                cloneBone.position.copy(origBone.position);
                cloneBone.quaternion.copy(origBone.quaternion);
                cloneBone.scale.copy(origBone.scale);
            });
        } else {
            // ----- Generic mesh: simple clone (shallow copy of hierarchy).
            cloneMesh = originalMesh.clone(true);
            cloneMesh.userData = { proxyEntityId: entityId };

            // Deep‑clone materials.
            cloneMesh.traverse((child) => {
                if (child.isMesh && child.material) {
                    if (Array.isArray(child.material)) {
                        child.material = child.material.map(mat => mat ? mat.clone() : null).filter(Boolean);
                    } else {
                        child.material = child.material.clone();
                    }
                }
            });
        }

        // ----- Transform the clone using the portal‑pair matrix -----
        // Compute the transformation matrix from entrance to exit.
        const pairMatrix = this._portalPairMatrix(entrancePortal, exitPortal);
        // Transform the clone's position.
        cloneMesh.position.copy(originalMesh.position).applyMatrix4(pairMatrix);
        // Extract rotation from the matrix and apply to the clone's quaternion.
        const rotMatrix = new THREE.Matrix4().extractRotation(pairMatrix);
        const pairQuat = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
        cloneMesh.quaternion.copy(pairQuat.clone().multiply(originalMesh.quaternion));
        // Copy scale.
        cloneMesh.scale.copy(originalMesh.scale);

        // Determine which side of the portal the original object is on.
        const signedDist = entrancePortal.signedDistance(originalMesh.position);
        const backSide = signedDist < 0;

        // Apply elliptic clipping to both original and clone.
        this._setOriginalClipping(originalMesh, entrancePortal, backSide, true);
        this._setCloneClipping(cloneMesh, exitPortal, backSide, true);

        // Add the clone to the scene.
        this.scene.add(cloneMesh);

        // Store proxy data for later updates.
        const proxyData = {
            entityId,
            originalMesh,
            cloneMesh,
            entrancePortal,
            exitPortal,
            crossedFraction,
            boneMap,            // null for generic meshes
            backSide,
        };
        this.activeProxies.set(entityId, proxyData);
    },

    /**
     * Updates all active proxies. Called every frame.
     * It updates the clone's transform to match the original's new position (via portal matrix),
     * updates clipping states based on how far the original has crossed, and syncs bone animations
     * if the mesh is skinned.
     * @returns {void}
     */
    updateAll() {
        // Guard: if not initialised, skip.
        if (!this.initialized) return;

        // Iterate over a copy of activeProxies to allow safe modifications during iteration.
        for (const [entityId, proxy] of this.activeProxies) {
            const { originalMesh, cloneMesh, entrancePortal, exitPortal, boneMap, backSide } = proxy;

            // Check if the object has fully passed the portal (signedDist < -player radius).
            // If so, stop the proxy (the object is now fully on the other side).
            const signedDist = entrancePortal.signedDistance(originalMesh.position);
            if (signedDist < -CLIENT_CONFIG.PLAYER_RADIUS) {
                this.stopProxy(entityId);
                continue;
            }

            // Determine the clipping state: if the object has crossed the portal plane,
            // we may want to revert to simple plane clipping (no ellipse) for efficiency.
            const crossed = (backSide && signedDist > 0) || (!backSide && signedDist < 0);
            const useElliptic = !crossed;

            // Apply the updated clipping to both meshes.
            this._setOriginalClipping(originalMesh, entrancePortal, backSide, useElliptic);
            this._setCloneClipping(cloneMesh, exitPortal, backSide, useElliptic);

            // Update the clone's transform to match the original's new position/rotation.
            const pairMatrix = this._portalPairMatrix(entrancePortal, exitPortal);
            cloneMesh.position.copy(originalMesh.position).applyMatrix4(pairMatrix);
            const rotMatrix = new THREE.Matrix4().extractRotation(pairMatrix);
            const pairQuat = new THREE.Quaternion().setFromRotationMatrix(rotMatrix);
            cloneMesh.quaternion.copy(pairQuat.clone().multiply(originalMesh.quaternion));
            cloneMesh.scale.copy(originalMesh.scale);

            // If the mesh is skinned, update all bone transforms from the original to the clone.
            if (boneMap) {
                boneMap.forEach((cloneBone, origBone) => {
                    cloneBone.position.copy(origBone.position);
                    cloneBone.quaternion.copy(origBone.quaternion);
                    cloneBone.scale.copy(origBone.scale);
                });
            }
        }
    },

    /**
     * Stops the proxy for the given entity: removes the clone from the scene,
     * clears clipping from the original, and deletes the proxy entry.
     * @param {string} entityId - The entity ID.
     * @returns {void}
     */
    stopProxy(entityId) {
        const proxy = this.activeProxies.get(entityId);
        if (!proxy) return;
        // Clear clipping from the original mesh.
        this._clearClipping(proxy.originalMesh);
        // Remove the clone from the scene.
        this.scene.remove(proxy.cloneMesh);
        // Delete the entry from the map.
        this.activeProxies.delete(entityId);
    },

    /**
     * Cancels all proxies that are associated with a given portal (by portal ID).
     * Used when a portal is removed from the scene.
     * @param {string} portalId - The ID of the portal being removed.
     * @returns {void}
     */
    cancelProxiesForPortal(portalId) {
        // Iterate over a copy of the keys to avoid mutation issues.
        for (const [entityId, proxy] of this.activeProxies) {
            if (proxy.entrancePortal.id === portalId || proxy.exitPortal.id === portalId) {
                this.stopProxy(entityId);
            }
        }
    },

    /**
     * Checks whether a proxy is active for the given entity.
     * @param {string} entityId - The entity ID.
     * @returns {boolean} True if a proxy exists, false otherwise.
     */
    isProxying(entityId) { return this.activeProxies.has(entityId); },

    /**
     * Retrieves the proxy data for the given entity.
     * @param {string} entityId - The entity ID.
     * @returns {Object|null} The proxy data or null if not found.
     */
    getProxy(entityId) { return this.activeProxies.get(entityId) || null; },

    /**
     * Clears all active proxies. Removes all clones from the scene and clears the map.
     * Used during world reset or portal manager clear.
     * @returns {void}
     */
    clear() { this.activeProxies.clear(); },
};