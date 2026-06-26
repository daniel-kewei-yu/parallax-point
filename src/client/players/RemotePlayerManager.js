/*
Author: Daniel Yu
Date: March 15, 2026
Description: Manages remote players: creates and updates avatars for other players in the scene.
             It loads the player GLTF model and portal gun model, creates animation mixers for
             upper and lower body, and handles equip/unequip animations. The class also processes
             remote player state updates from the worker and synchronises position, rotation,
             scale, and animation state. It includes a fallback for when the model fails to load.
*/

// Import Three.js core for vectors, quaternions, and Euler angles.
import * as THREE from 'three';
// Import the GLTFLoader to load remote player models.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// Import SkeletonUtils to clone skinned meshes.
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';
// Import client configuration constants (model scale, gun placement, etc.).
import { CLIENT_CONFIG } from '../clientConfig.js';
// Import the global game state singleton.
import { GameState } from '../clientState.js';
// Import utility to create a quaternion from yaw (used for model rotation).
import { getYawQuaternion } from '../clientUtils.js';

/**
 * Singleton object that manages all remote players.
 * It maintains a map of player IDs to remote player objects, loads models,
 * creates avatars, and updates them based on worker state.
 */
export const RemotePlayerManager = {
    // Map from player ID to remote player data.
    remotePlayers: GameState.remotePlayers,
    // The loaded player GLTF (scene) used as a template for cloning.
    playerModel: null,
    // The loaded gun GLTF (scene) used as a template for cloning.
    gunModel: null,
    // Flags indicating whether models have finished loading.
    playerModelLoaded: false,
    gunModelLoaded: false,
    // The GLTFLoader instance.
    loader: new GLTFLoader(),
    // Queue of pending avatar creations (for players that join before the model loads).
    pendingAvatarCreations: [],
    // Map from playerId to pending equip states (for players whose equip state arrives before avatar creation).
    pendingEquipStates: new Map(),
    // Cached animation tracks for remote players (used to apply locomotion animations).
    remoteLocomotionTracks: null,

    /**
     * Normalises a bone name by removing common prefixes like "mixamorig:" and trailing numbers.
     * This allows matching bone names across different rigs.
     * @param {string} name - The raw bone name from the animation track.
     * @returns {string} The normalised bone name.
     */
    normalizeBoneName(name) {
        let normalized = name.replace(/^(mixamorig:|Armature_|Armature\.)/i, '');
        normalized = normalized.replace(/\d+$/, '');
        return normalized;
    },

    /**
     * Filters an animation clip to keep only tracks for allowed bone names.
     * Used to separate upper and lower body animations.
     * @param {THREE.AnimationClip} clip - The original animation clip.
     * @param {string[]} allowedBoneNames - Array of normalised bone names to keep.
     * @returns {THREE.AnimationClip|null} The filtered clip, or null if no tracks remain.
     */
    filterAnimationClip(clip, allowedBoneNames) {
        // Filter tracks to only those whose bone name is in the allowed list.
        const filteredTracks = clip.tracks.filter(track => {
            const dotIndex = track.name.lastIndexOf('.');
            if (dotIndex === -1) return false;
            const boneName = track.name.substring(0, dotIndex);
            const normalizedBone = this.normalizeBoneName(boneName);
            return allowedBoneNames.includes(normalizedBone);
        });
        if (filteredTracks.length === 0) return null;
        return new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
    },

    /**
     * Initialises the remote player manager by loading the player and gun models.
     * @returns {void}
     */
    init() {
        this.loadPlayerModel();
        this.loadGunModel();
    },

    /**
     * Loads the player GLTF model for remote avatars.
     * Once loaded, it prepares animation tracks and processes pending creations.
     * @returns {void}
     */
    loadPlayerModel() {
        this.loader.load(
            'assets/models/thePlayer.glb',
            (gltf) => {
                // Store the loaded GLTF (scene) for later cloning.
                this.playerModel = gltf;
                // If animations exist, prepare the remote locomotion tracks cache.
                if (gltf.animations) this.prepareRemoteAnimationTracks();
                this.playerModelLoaded = true;
                // Process any avatars that were queued while the model was loading.
                this.processPendingCreations();
                // If the gun model is also loaded, attach guns to existing remote players.
                if (this.gunModelLoaded) this.attachGunToRemotePlayers();
            },
            undefined,
            (error) => {
                console.error('Failed to load remote player model:', error);
                // Even on failure, mark as loaded so we use capsule fallback.
                this.playerModelLoaded = true;
                this.processPendingCreations();  // Fallback: use capsules.
            }
        );
    },

    /**
     * Loads the portal gun model for remote players.
     * @returns {void}
     */
    loadGunModel() {
        this.loader.load(
            'assets/models/portalGun.glb',
            (gltf) => {
                this.gunModel = gltf;
                this.gunModelLoaded = true;
                // If the player model is already loaded, attach guns to existing remote players.
                if (this.playerModelLoaded) this.attachGunToRemotePlayers();
            },
            undefined,
            (error) => console.error('Failed to load gun model for remote players:', error)
        );
    },

    /**
     * Processes any pending avatar creations after the model loads.
     * Also applies any pending equip states.
     * @returns {void}
     */
    processPendingCreations() {
        // Create avatars for all pending entries.
        this.pendingAvatarCreations.forEach(({ playerId, state }) => this.createRemoteAvatar(playerId, state));
        // Clear the pending queue.
        this.pendingAvatarCreations = [];
        // Apply any pending equip states that were stored before the avatar existed.
        this.pendingEquipStates.forEach(({ equipped, inHoldPose }, playerId) => {
            this.setRemoteEquipState(playerId, equipped, false, inHoldPose);
        });
        this.pendingEquipStates.clear();
    },

    /**
     * Prepares animation track maps for remote players.
     * For each locomotion clip (walk, jump, idle), it builds a map from bone name to track objects.
     * This is used to apply animations to remote players without using full AnimationMixers.
     * (Currently, this is not used in the update loop but kept for potential future optimisation.)
     * @returns {void}
     */
    prepareRemoteAnimationTracks() {
        if (!this.playerModel?.animations) return;
        const anims = this.playerModel.animations;
        // Helper to find an animation by keywords.
        const findAnim = (keywords) => anims.find(a => keywords.some(k => a.name.toLowerCase().includes(k)));
        const walkClip = findAnim(['walk', 'crouch']);
        const jumpClip = findAnim(['jump']);
        const idleClip = findAnim(['idle']);

        this.remoteLocomotionTracks = {};
        // Process a single clip and store its bone tracks.
        const processClip = (clip, name) => {
            if (!clip) return;
            const boneTracks = new Map();
            for (const track of clip.tracks) {
                const dotIndex = track.name.lastIndexOf('.');
                if (dotIndex === -1) continue;
                const boneName = track.name.substring(0, dotIndex);
                const property = track.name.substring(dotIndex + 1);
                const normalized = this.normalizeBoneName(boneName);
                if (!boneTracks.has(normalized)) boneTracks.set(normalized, {});
                const data = boneTracks.get(normalized);
                if (property === 'position') data.pos = track;
                else if (property === 'quaternion') data.quat = track;
                else if (property === 'scale') data.scale = track;
            }
            this.remoteLocomotionTracks[name] = boneTracks;
        };
        processClip(walkClip, 'walk');
        processClip(jumpClip, 'jump');
        processClip(idleClip, 'idle');
    },

    /**
     * Updates lower body animation mixer for a remote player (unused, kept for future).
     * Currently, remote players use full AnimationMixers, so this is not called.
     * @param {Object} player - Remote player object.
     * @param {number} deltaTime - Time since last update.
     * @returns {void}
     */
    applyLocomotionToLowerBody(player, deltaTime) {
        if (!player.lowerMixer) return;
        player.lowerMixer.update(deltaTime);
    },

    /**
     * Attaches the gun model to all existing remote players.
     * Called once both player and gun models are loaded.
     * @returns {void}
     */
    attachGunToRemotePlayers() {
        if (!this.gunModel) return;
        for (const [_, player] of this.remotePlayers) {
            // If the player already has a gun, skip.
            if (!player.gun && player.avatar) {
                // Find the right hand bone.
                let rightHand = null;
                player.avatar.traverse(child => {
                    if (child.isBone && child.name.toLowerCase().includes('right') && child.name.toLowerCase().includes('hand'))
                        rightHand = child;
                });
                if (!rightHand) rightHand = player.avatar; // Fallback to root.
                // Clone the gun model and attach it.
                const gun = SkeletonUtils.clone(this.gunModel.scene);
                gun.scale.set(CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE);
                gun.visible = player.isEquipped;
                rightHand.add(gun);
                gun.position.copy(CLIENT_CONFIG.GUN_POSITION);
                gun.rotation.set(CLIENT_CONFIG.GUN_ROTATION.x, CLIENT_CONFIG.GUN_ROTATION.y, CLIENT_CONFIG.GUN_ROTATION.z);
                // Tag gun meshes as remote avatar parts.
                gun.traverse(child => { if (child.isMesh) child.userData.remoteAvatar = true; });
                player.gun = gun;
            }
        }
    },

    /**
     * Creates a remote avatar for a player. Uses a full GLTF model if available,
     * otherwise falls back to an invisible cylinder (capsule) for collision representation.
     * @param {string} playerId - The player's ID.
     * @param {Object} state - The player state from the worker.
     * @returns {THREE.Object3D|null} The avatar model or null if fallback.
     */
    createRemoteAvatar(playerId, state) {
        // If the model is not loaded yet, queue this creation for later.
        if (!this.playerModelLoaded) {
            this.pendingAvatarCreations.push({ playerId, state });
            return null;
        }

        // If the model failed to load, fallback to an invisible capsule.
        if (!this.playerModel) {
            // Determine the position (foot position).
            const pos = (state.held && state.heldPos) ? new THREE.Vector3().fromArray(state.heldPos) : new THREE.Vector3().fromArray(state.position);
            // Create a cylinder mesh with transparent material (invisible but present for raycasting).
            const cylinder = new THREE.Mesh(
                new THREE.CylinderGeometry(CLIENT_CONFIG.PLAYER_RADIUS, CLIENT_CONFIG.PLAYER_RADIUS, CLIENT_CONFIG.PLAYER_HEIGHT, 8),
                new THREE.MeshPhongMaterial({
                    transparent: true,
                    opacity: 0,
                    colorWrite: false,
                    depthWrite: false
                })
            );
            // Position the capsule so its base is at the foot position.
            cylinder.position.set(pos.x, pos.y + CLIENT_CONFIG.PLAYER_HEIGHT / 2, pos.z);
            cylinder.userData.remoteAvatarCapsule = true; // Tag for raycasting.
            GameState.scene.add(cylinder);

            // Create a minimal player object with only capsule and basic state.
            const player = {
                avatar: null,
                capsule: cylinder,
                offsetY: 0,
                lowerMixer: null,
                upperMixer: null,
                lowerActions: {},
                upperLocomotionActions: {},
                drawAction: null,
                isEquipped: state.isEquipped,
                isHoldingPose: false,
                holdPose: null,
                upperBodyBones: [],
                lowerBodyBones: [],
                currentLowerAnim: null,
                currentUpperAnim: null,
                lastPos: pos.clone(),
                lastTime: performance.now(),
                lastSpeed: 0,
                lastOnGround: true,
                movingTimer: 0,
                held: state.held || false,
                scale: state.scale || 1,
                gun: null,
                isAnimating: false,
            };
            this.remotePlayers.set(playerId, player);
            return cylinder;
        }

        // --- Full avatar with model ---
        // Remove any existing avatar for this player.
        this.removeAvatar(playerId);

        // Determine the foot position.
        const pos = (state.held && state.heldPos) ? new THREE.Vector3().fromArray(state.heldPos) : new THREE.Vector3().fromArray(state.position);
        const targetScale = state.scale !== undefined ? Math.max(state.scale, 0.01) : 1;

        // Clone the player scene (SkeletonUtils.clone handles skinned mesh duplication).
        const clonedScene = SkeletonUtils.clone(this.playerModel.scene);
        // Apply the base scale and target scale.
        const totalScale = CLIENT_CONFIG.MODEL_SCALE * targetScale;
        clonedScene.scale.set(totalScale, totalScale, totalScale);

        // Compute the offset from the model's origin to its foot (to align with foot position).
        const box = new THREE.Box3().setFromObject(clonedScene);
        const offsetY = -box.min.y;
        // Position the model so its feet are at the foot position.
        clonedScene.position.set(pos.x, pos.y + offsetY, pos.z);
        // Apply the initial rotation offset.
        clonedScene.quaternion.copy(CLIENT_CONFIG.MODEL_ROTATION_OFFSET);

        // Tag all meshes as remote avatar parts.
        clonedScene.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material) {
                    if (Array.isArray(child.material)) child.material.forEach(m => m.transparent = false);
                    else child.material.transparent = false;
                }
                child.userData.remoteAvatar = true;
            }
        });
        GameState.scene.add(clonedScene);

        // Find the right hand bone for the gun.
        let rightHand = null;
        clonedScene.traverse(child => {
            if (child.isBone && child.name.toLowerCase().includes('right') && child.name.toLowerCase().includes('hand'))
                rightHand = child;
        });
        if (!rightHand) rightHand = clonedScene;

        // Create the gun model if available.
        let gun = null;
        if (this.gunModelLoaded && this.gunModel) {
            gun = SkeletonUtils.clone(this.gunModel.scene);
            gun.scale.set(CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE, CLIENT_CONFIG.GUN_SCALE);
            gun.visible = state.isEquipped;
            rightHand.add(gun);
            gun.position.copy(CLIENT_CONFIG.GUN_POSITION);
            gun.rotation.set(CLIENT_CONFIG.GUN_ROTATION.x, CLIENT_CONFIG.GUN_ROTATION.y, CLIENT_CONFIG.GUN_ROTATION.z);
            gun.traverse(child => { if (child.isMesh) child.userData.remoteAvatar = true; });
        }

        // Create an invisible collision capsule (visible with 0.5 opacity for debugging).
        const cylinder = new THREE.Mesh(
            new THREE.CylinderGeometry(CLIENT_CONFIG.PLAYER_RADIUS, CLIENT_CONFIG.PLAYER_RADIUS, CLIENT_CONFIG.PLAYER_HEIGHT, 8),
            new THREE.MeshPhongMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.5,
            })
        );
        cylinder.position.set(pos.x, pos.y + CLIENT_CONFIG.PLAYER_HEIGHT / 2, pos.z);
        cylinder.userData.remoteAvatarCapsule = true;
        GameState.scene.add(cylinder);

        // Separate bones into upper and lower for animation mixing.
        const upperBones = [], lowerBones = [];
        clonedScene.traverse(child => {
            if (!child.isBone) return;
            const name = child.name.toLowerCase();
            if (/spine|neck|head|clavicle|arm|hand|shoulder/.test(name)) upperBones.push(child);
            if (/hip|thigh|calf|foot|toe|leg|pelvis/.test(name)) lowerBones.push(child);
        });

        const upperBoneNames = upperBones.map(b => this.normalizeBoneName(b.name));
        const lowerBoneNames = lowerBones.map(b => this.normalizeBoneName(b.name));

        // Create animation mixers for upper and lower body.
        const lowerMixer = new THREE.AnimationMixer(clonedScene);
        const upperMixer = new THREE.AnimationMixer(clonedScene);

        let lowerActions = {};
        let upperLocomotionActions = {};
        let drawAction = null;

        // Process animations from the loaded model.
        if (this.playerModel.animations) {
            const anims = this.playerModel.animations;
            const walk = anims.find(a => a.name.toLowerCase().includes('walk') || a.name.toLowerCase().includes('crouch'));
            const jump = anims.find(a => a.name.toLowerCase().includes('jump'));
            const idle = anims.find(a => a.name.toLowerCase().includes('idle'));
            const draw = anims.find(a => a.name.toLowerCase().includes('draw') || a.name.toLowerCase().includes('pull') || a.name.toLowerCase().includes('equip'));

            // Lower body actions.
            if (walk) {
                const lowerWalk = this.filterAnimationClip(walk, lowerBoneNames);
                if (lowerWalk) lowerActions.walk = lowerMixer.clipAction(lowerWalk).setLoop(THREE.LoopRepeat);
                const upperWalk = this.filterAnimationClip(walk, upperBoneNames);
                if (upperWalk) upperLocomotionActions.walk = upperMixer.clipAction(upperWalk).setLoop(THREE.LoopRepeat);
            }
            if (jump) {
                const lowerJump = this.filterAnimationClip(jump, lowerBoneNames);
                if (lowerJump) lowerActions.jump = lowerMixer.clipAction(lowerJump).setLoop(THREE.LoopRepeat);
                const upperJump = this.filterAnimationClip(jump, upperBoneNames);
                if (upperJump) upperLocomotionActions.jump = upperMixer.clipAction(upperJump).setLoop(THREE.LoopRepeat);
            }
            if (idle) {
                const lowerIdle = this.filterAnimationClip(idle, lowerBoneNames);
                if (lowerIdle) lowerActions.idle = lowerMixer.clipAction(lowerIdle).setLoop(THREE.LoopRepeat);
                const upperIdle = this.filterAnimationClip(idle, upperBoneNames);
                if (upperIdle) upperLocomotionActions.idle = upperMixer.clipAction(upperIdle).setLoop(THREE.LoopRepeat);
            }
            if (draw) {
                const filteredDraw = this.filterAnimationClip(draw, upperBoneNames);
                if (filteredDraw) {
                    drawAction = upperMixer.clipAction(filteredDraw);
                    drawAction.setLoop(THREE.LoopOnce);
                    drawAction.clampWhenFinished = true;
                }
            }
        }

        // Build the remote player object.
        const player = {
            avatar: clonedScene,
            capsule: cylinder,
            offsetY,
            lowerMixer,
            upperMixer,
            lowerActions,
            upperLocomotionActions,
            drawAction,
            isEquipped: state.isEquipped,
            inHoldPose: state.inHoldPose || false,
            isHoldingPose: false,
            holdPose: null,
            upperBodyBones: upperBones,
            lowerBodyBones: lowerBones,
            currentLowerAnim: null,
            currentUpperAnim: null,
            lastPos: pos.clone(),
            lastTime: performance.now(),
            lastSpeed: 0,
            lastOnGround: true,
            movingTimer: 0,
            held: state.held || false,
            scale: targetScale,
            gun: gun,
            isAnimating: false,
        };

        // Start idle animations.
        if (lowerActions.idle) {
            lowerActions.idle.play();
            player.currentLowerAnim = 'idle';
        }
        if (upperLocomotionActions.idle) {
            upperLocomotionActions.idle.play();
            player.currentUpperAnim = 'idle';
        }

        // Store the player in the remotePlayers map.
        this.remotePlayers.set(playerId, player);

        // Handle equip state based on worker state.
        if (state.isEquipped) {
            if (state.inHoldPose) {
                this.applyRemoteHoldPose(player);
            } else {
                this.setRemoteEquipState(playerId, true, true);
            }
        } else if (this.pendingEquipStates.has(playerId)) {
            // Apply any pending equip state that was received before the avatar was created.
            const { equipped, inHoldPose } = this.pendingEquipStates.get(playerId);
            this.setRemoteEquipState(playerId, equipped, false, inHoldPose);
            this.pendingEquipStates.delete(playerId);
        }

        return clonedScene;
    },

    /**
     * Instantly applies the equipped hold pose to a remote player (no animation).
     * This freezes the upper body bones at the draw animation's end pose.
     * @param {Object} player - The remote player object.
     * @returns {void}
     */
    applyRemoteHoldPose(player) {
        if (!player.drawAction) return;
        if (player.isHoldingPose) return;

        // Stop any current upper body locomotion animation.
        if (player.currentUpperAnim && player.upperLocomotionActions[player.currentUpperAnim]) {
            player.upperLocomotionActions[player.currentUpperAnim].stop();
        }

        // Set the draw action to the end time and apply the pose.
        const dur = player.drawAction.getClip().duration;
        player.drawAction.time = dur;
        player.drawAction.play();
        player.upperMixer.update(0);

        // Freeze the upper body bones.
        player.holdPose = new Map();
        player.upperBodyBones.forEach(bone => {
            player.holdPose.set(bone, {
                pos: bone.position.clone(),
                quat: bone.quaternion.clone(),
                scale: bone.scale.clone(),
            });
        });
        player.isHoldingPose = true;
        player.isAnimating = false;
        player.currentUpperAnim = null;
        player.drawAction.stop();

        // Show the gun.
        if (player.gun) player.gun.visible = true;
    },

    /**
     * Updates a remote player's avatar based on state from the worker.
     * Called for every remote player on each world_state message.
     * @param {string} playerId - The player ID.
     * @param {Object} state - The latest state from the worker.
     * @returns {void}
     */
    updateRemoteAvatar(playerId, state) {
        // Check if this player is held by us (forced perspective). If so, we don't update their position/rotation
        // because we control it on our side.
        const isHeldByUs = (GameState.heldObjectType === 'player' && GameState.heldPlayerId === playerId);

        // Retrieve or create the player object.
        let player = this.remotePlayers.get(playerId);
        if (!player) {
            this.createRemoteAvatar(playerId, state);
            player = this.remotePlayers.get(playerId);
            if (!player) return;
        }

        // If the player has no avatar but the model is loaded, recreate.
        if (!player.avatar && this.playerModelLoaded && this.playerModel) {
            this.removeAvatar(playerId);
            this.createRemoteAvatar(playerId, state);
            player = this.remotePlayers.get(playerId);
            if (!player) return;
        }

        // Handle change in held state (for forced perspective).
        const wasHeld = player.held;
        if (wasHeld && !state.held) {
            // If the player was held and is now released, clear hold pose.
            player.isHoldingPose = false;
            player.holdPose = null;
        }

        // Determine the position (foot position).
        let pos;
        if (state.held && state.heldPos && Array.isArray(state.heldPos) && state.heldPos.length >= 3) {
            pos = new THREE.Vector3().fromArray(state.heldPos);
        } else if (state.position && Array.isArray(state.position) && state.position.length >= 3) {
            pos = new THREE.Vector3().fromArray(state.position);
        } else {
            console.warn(`Remote player ${playerId} has invalid position data, skipping update`);
            return;
        }

        const targetScale = state.scale !== undefined ? Math.max(state.scale, 0.01) : 1;

        // Update position and rotation if not held by us.
        if (!isHeldByUs && player.avatar) {
            // Position the model: foot + offsetY * scale.
            const scaledOffset = player.offsetY * targetScale;
            player.avatar.position.set(pos.x, pos.y + scaledOffset, pos.z);
            // Set rotation.
            if (state.held && state.heldRot && Array.isArray(state.heldRot) && state.heldRot.length >= 4) {
                // If held, use the exact rotation from the state.
                player.avatar.quaternion.fromArray(state.heldRot);
            } else if (!state.held) {
                // Not held: use yaw with optional extra yaw if in hold pose.
                let yaw = state.rotation;
                if (player.isHoldingPose) yaw += CLIENT_CONFIG.EXTRA_YAW_DEGREES;
                player.avatar.quaternion.copy(CLIENT_CONFIG.MODEL_ROTATION_OFFSET.clone().multiply(getYawQuaternion(yaw)));
            }

            // Ensure the model's feet are exactly at the foot position (correct for bounding box drift).
            const box = new THREE.Box3().setFromObject(player.avatar);
            const bottom = box.min.y;
            const diff = bottom - pos.y;
            if (Math.abs(diff) > 0.001) {
                player.avatar.position.y -= diff;
            }
        }

        // Update the collision capsule.
        if (player.capsule) {
            const halfHeight = (CLIENT_CONFIG.PLAYER_HEIGHT / 2) * targetScale;
            player.capsule.position.set(pos.x, pos.y + halfHeight, pos.z);
            player.capsule.scale.set(targetScale, targetScale, targetScale);
            if (player.avatar && !isHeldByUs) {
                player.capsule.quaternion.copy(player.avatar.quaternion);
            }
            player.capsule.visible = true;
        }

        // Scale the avatar if not held by us.
        if (player.avatar && !isHeldByUs) {
            const totalScale = CLIENT_CONFIG.MODEL_SCALE * targetScale;
            player.avatar.scale.set(totalScale, totalScale, totalScale);
        }

        // Update state flags.
        player.held = state.held || false;
        player.scale = targetScale;

        // ---- Equip state with hold pose ----
        const wasEquipped = player.isEquipped;
        const isEquippedNow = state.isEquipped;
        const inHoldPoseNow = state.inHoldPose;

        if (wasEquipped !== isEquippedNow) {
            // If equip state changed, apply the new state (with or without animation).
            this.setRemoteEquipState(playerId, isEquippedNow, true, inHoldPoseNow);
        } else if (isEquippedNow && !player.isHoldingPose && inHoldPoseNow) {
            // If already equipped but not in hold pose, and the worker says we should be, apply hold pose.
            this.applyRemoteHoldPose(player);
        } else if (!isEquippedNow && player.isHoldingPose) {
            // If unequipped but still in hold pose, force exit hold pose.
            player.isHoldingPose = false;
            player.holdPose = null;
            if (player.drawAction) player.drawAction.stop();
            // Restart upper locomotion based on current lower anim.
            if (player.currentLowerAnim && player.upperLocomotionActions[player.currentLowerAnim]) {
                player.upperLocomotionActions[player.currentLowerAnim].reset().play();
                player.currentUpperAnim = player.currentLowerAnim;
            }
            if (player.gun) player.gun.visible = false;
        } else if (!isEquippedNow && !player.isAnimating && player.gun) {
            // Ensure gun is hidden when unequipped and not animating.
            player.gun.visible = false;
        }

        player.isEquipped = isEquippedNow;
        player.inHoldPose = inHoldPoseNow;

        // ---- Determine target lower body animation ----
        let targetLowerAnim = null;
        if (!state.held) {
            const vel = state.velocity || [0, 0, 0];
            const speed = Math.sqrt(vel[0] * vel[0] + vel[2] * vel[2]);
            const now = performance.now();
            const dt = Math.min(0.1, (now - player.lastTime) / 1000);
            player.lastTime = now;

            // Update moving timer.
            if (speed > CLIENT_CONFIG.MOVING_SPEED_THRESHOLD) player.movingTimer = CLIENT_CONFIG.MOVING_TIMEOUT;
            else if (player.movingTimer > 0) player.movingTimer -= dt;

            const moving = player.movingTimer > 0;
            const onGround = state.onGround;
            const isRising = vel[1] > 0.5;

            if (!onGround) {
                if (isRising) targetLowerAnim = 'jump';
                else targetLowerAnim = 'idle';
            } else if (moving) {
                targetLowerAnim = 'walk';
            } else {
                targetLowerAnim = 'idle';
            }
        } else {
            targetLowerAnim = 'idle';
        }

        // Update lower body animation.
        if (targetLowerAnim && player.lowerActions[targetLowerAnim] && player.currentLowerAnim !== targetLowerAnim) {
            if (player.currentLowerAnim && player.lowerActions[player.currentLowerAnim]) {
                player.lowerActions[player.currentLowerAnim].fadeOut(0.2);
            }
            player.lowerActions[targetLowerAnim].reset().fadeIn(0.2).play();
            player.currentLowerAnim = targetLowerAnim;
        }

        // Upper body locomotion if not equipped, not animating, and not in hold pose.
        if (!player.isEquipped && !player.isAnimating && !player.isHoldingPose) {
            const targetUpperAnim = targetLowerAnim;
            if (targetUpperAnim && player.upperLocomotionActions[targetUpperAnim] && player.currentUpperAnim !== targetUpperAnim) {
                if (player.currentUpperAnim && player.upperLocomotionActions[player.currentUpperAnim]) {
                    player.upperLocomotionActions[player.currentUpperAnim].fadeOut(0.2);
                }
                player.upperLocomotionActions[targetUpperAnim].reset().fadeIn(0.2).play();
                player.currentUpperAnim = targetUpperAnim;
            }
        }

        player.lastPos.copy(pos);
    },

    /**
     * Sets the equip state for a remote player (with optional animation).
     * @param {string} playerId - The player ID.
     * @param {boolean} equipped - New equip state.
     * @param {boolean} playAnimation - Whether to play the equip/unequip animation.
     * @param {boolean} inHoldPose - Whether the player should already be in the hold pose.
     * @returns {void}
     */
    setRemoteEquipState(playerId, equipped, playAnimation = true, inHoldPose = false) {
        const player = this.remotePlayers.get(playerId);
        if (!player) {
            // If player doesn't exist yet, store the equip state for later.
            this.pendingEquipStates.set(playerId, { equipped, inHoldPose });
            return;
        }
        if (player.isEquipped === equipped && player.inHoldPose === inHoldPose) return;
        player.isEquipped = equipped;
        player.inHoldPose = inHoldPose;

        const drawAction = player.drawAction;
        const upperLocomotion = player.upperLocomotionActions;

        if (!drawAction) {
            if (player.gun) player.gun.visible = equipped;
            return;
        }

        if (equipped) {
            // Equipping.
            if (playAnimation && !inHoldPose) {
                // Play draw animation.
                if (player.currentUpperAnim && upperLocomotion[player.currentUpperAnim]) {
                    upperLocomotion[player.currentUpperAnim].fadeOut(0.2);
                }
                player.isAnimating = true;
                drawAction.reset().play();
                player.currentUpperAnim = 'draw';

                const onFinish = () => {
                    if (player.upperMixer) player.upperMixer.update(0);
                    // Freeze upper body.
                    player.holdPose = new Map();
                    player.upperBodyBones.forEach(bone => {
                        player.holdPose.set(bone, {
                            pos: bone.position.clone(),
                            quat: bone.quaternion.clone(),
                            scale: bone.scale.clone(),
                        });
                    });
                    player.isHoldingPose = true;
                    player.isAnimating = false;
                    player.currentUpperAnim = null;
                    drawAction.stop();
                    player.upperMixer.removeEventListener('finished', onFinish);
                };
                player.upperMixer.addEventListener('finished', onFinish);
                if (player.gun) player.gun.visible = true;
            } else {
                // Direct hold pose (no animation).
                this.applyRemoteHoldPose(player);
            }
        } else {
            // Unequipping.
            if (playAnimation) {
                // Play reverse animation.
                player.isAnimating = true;
                const dur = drawAction.getClip().duration;
                drawAction.stop();
                drawAction.timeScale = -1;
                drawAction.time = dur;
                drawAction.play();
                player.currentUpperAnim = 'unequip';
                player.isHoldingPose = false;
                player.holdPose = null;

                const onFinish = () => {
                    drawAction.timeScale = 1;
                    if (player.gun) player.gun.visible = false;
                    player.isAnimating = false;
                    player.currentUpperAnim = null;
                    drawAction.stop();
                    player.upperMixer.removeEventListener('finished', onFinish);
                    // Restart upper locomotion.
                    if (player.currentLowerAnim && upperLocomotion[player.currentLowerAnim]) {
                        upperLocomotion[player.currentLowerAnim].reset().fadeIn(0.2).play();
                        player.currentUpperAnim = player.currentLowerAnim;
                    }
                };
                player.upperMixer.addEventListener('finished', onFinish);
            } else {
                // Immediate unequip.
                player.isAnimating = false;
                player.isHoldingPose = false;
                player.holdPose = null;
                if (player.gun) player.gun.visible = false;
                drawAction.stop();
                player.currentUpperAnim = null;
                if (player.currentLowerAnim && upperLocomotion[player.currentLowerAnim]) {
                    upperLocomotion[player.currentLowerAnim].reset().play();
                    player.currentUpperAnim = player.currentLowerAnim;
                }
            }
        }
    },

    /**
     * Updates remote player animations (called every frame from animationLoop.js).
     * Updates both lower and upper mixers, and applies hold pose if active.
     * @param {number} deltaTime - Time elapsed since last update in seconds.
     * @returns {void}
     */
    updateRemoteAnimations(deltaTime) {
        // Iterate over all remote players.
        for (const player of this.remotePlayers.values()) {
            // Update lower mixer.
            if (player.lowerMixer) player.lowerMixer.update(deltaTime);

            // Update upper mixer if appropriate.
            if (player.upperMixer) {
                if (player.isAnimating && (player.currentUpperAnim === 'draw' || player.currentUpperAnim === 'unequip')) {
                    // If animating equip/unequip, update the mixer.
                    player.upperMixer.update(deltaTime);
                } else if (!player.isHoldingPose && !player.isAnimating && player.currentUpperAnim) {
                    // Otherwise, update for locomotion animations.
                    player.upperMixer.update(deltaTime);
                }
            }

            // If in hold pose, freeze upper body bones.
            if (player.isHoldingPose && player.holdPose) {
                player.upperBodyBones.forEach(bone => {
                    const pose = player.holdPose.get(bone);
                    if (pose) {
                        bone.position.copy(pose.pos);
                        bone.quaternion.copy(pose.quat);
                        bone.scale.copy(pose.scale);
                    }
                });
            }
        }
    },

    /**
     * Removes a remote avatar from the scene.
     * @param {string} playerId - The player ID.
     * @returns {void}
     */
    removeAvatar(playerId) {
        const player = this.remotePlayers.get(playerId);
        if (player) {
            // Remove avatar and capsule from scene.
            if (player.avatar) GameState.scene.remove(player.avatar);
            GameState.scene.remove(player.capsule);
            // Stop all actions on mixers.
            if (player.lowerMixer) player.lowerMixer.stopAllAction();
            if (player.upperMixer) player.upperMixer.stopAllAction();
            // Delete from map.
            this.remotePlayers.delete(playerId);
        }
    },
};