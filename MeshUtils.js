// ===============================================
// MeshUtils.js (Fixed)
// JSON-driven attachment resolution + layered overrides
// ===============================================

export const MeshUtils = {

  DEFAULT_ATTACHMENT_TRANSFORMS: {
    "head/hat": { position: [0.0, 0.190766, 0.0] },
    "head/glasses": { position: [0.0, 0.008302, -0.203441] },
    "head/glasses/mouth": { position: [0.0, -0.192385, -0.291841] },
    "body/backpack": { position: [0.0, -0.311955, 0.278574] },
    "body/neck": { position: [0, 0, 0] },
    "body/neck/chest": { position: [0.0, -0.300416, -0.124705] },
    "body/badge/left": { position: [-0.134673, -0.267122, -0.088314], rotation: [15.5, -1.24, 0.0] },
    "body/badge/right": { position: [0.134673, -0.267122, -0.088314], rotation: [-15.5, -1.24, 0.0] }
  },

  /**
   * Apply transform {position:[x,y,z], rotation:[deg,deg,deg], scale:num_or_[x,y,z]}
   * This now correctly handles scale as either a float (multiplyScalar) or an array (set).
   */
  applyTransform(object3D, grabTransform = {}) {
    if (!grabTransform) return;

    object3D.position.set(0, 0, 0);
    object3D.rotation.set(0, 0, 0);
    object3D.scale.set(1, 1, 1); // <--- Reset scale

    if (grabTransform.position) {
      object3D.position.set(...grabTransform.position);
    }

    if (grabTransform.rotation) {
      const radians = grabTransform.rotation.map(deg => THREE.MathUtils.degToRad(deg));
      object3D.rotation.set(radians[1], radians[0], radians[2], 'YXZ');
    }

    // --- MODIFIED to handle float or array ---
    if (grabTransform.scale !== undefined && grabTransform.scale !== null) {
      const s = grabTransform.scale;
      if (typeof s === 'number') {
        object3D.scale.multiplyScalar(s); // Use multiplyScalar for floats
      } else if (Array.isArray(s)) {
        object3D.scale.set(...s); // Use set for arrays
      }
    }
    // --- END MODIFICATION ---

    object3D.updateMatrixWorld(true);
  },

  toVec3(val, def = [1, 1, 1]) {
    if (Array.isArray(val)) return val;
    if (typeof val === "number") return [val, val, val];
    if (val && typeof val === "object" && "x" in val) {
      return [val.x ?? def[0], val.y ?? def[1], val.z ?? def[2]];
    }
    return def;
  },

  applyMaterialIndices(group, itemConfig) {
    if (!itemConfig.materials) return;

    const meshes = [];
    group.traverse(child => {
      if (child.isMesh) {
        meshes.push(child);
      }
    });

    meshes.forEach((mesh, index) => {
      const materialConf = itemConfig.materials[index];
      if (materialConf) {
        mesh.name = materialConf.type || "default";
        mesh.userData.materialIndex = index;
      }
    });
  },

  applyPlayerColors(group, itemConfig, primaryColor, secondaryColor) {
    const colorMap = {
      default_color: (index) => {
        const materialConf = itemConfig.materials?.[index];
        if (materialConf && Array.isArray(materialConf.diffuseColor)) {
          return new THREE.Color(...materialConf.diffuseColor);
        }
        return null;
      },
      default_primary_color: () => primaryColor,
      default_secondary_color: () => secondaryColor,
      default_primary_color_visor: () => MeshUtils.halfColor(primaryColor),
      default_secondary_color_visor: () => MeshUtils.halfColor(secondaryColor),
      default_primary_color_darkened: () => MeshUtils.halfColor(primaryColor),
      default_secondary_color_darkened: () => MeshUtils.halfColor(secondaryColor),
    };

    group.traverse((obj) => {
      if (obj.isMesh && colorMap[obj.name] && obj.userData.materialIndex !== undefined) {
        const color = colorMap[obj.name](obj.userData.materialIndex);

        if (color) {
          if (!obj.material.isMaterial) {
            obj.material = new THREE.MeshStandardMaterial();
          }
          obj.material.color.set(color);
        }
      }
    });
  },

  halfColor(color) {
    return color.clone().multiplyScalar(0.5);
  },

  // Create empty Objects as sockets for editor visualization
  createAttachmentSockets(modelGroup, itemConfig) {
    if (!itemConfig || !itemConfig.attachment_points) return;

    const ensurePath = (root, path) => {
      const parts = path.split('/');
      let cur = root;
      for (const p of parts) {
        let child = cur.children.find(c => c.name === p && c.userData && c.userData.isSocket);
        if (!child) {
          child = new THREE.Object3D();
          child.name = p;
          child.userData.isSocket = true;
          cur.add(child);
        }
        cur = child;
      }
      return cur;
    };

    const walk = (prefix, node) => {
      Object.entries(node).forEach(([key, val]) => {
        const full = prefix ? `${prefix}/${key}` : key;
        if (val && typeof val === 'object' && (val.position || val.rotation || val.scale)) {
          const socket = ensurePath(modelGroup, full);
          this.applyTransform(socket, val);
        } else if (val && typeof val === 'object') {
          walk(full, val);
        }
      });
    };

    walk('', itemConfig.attachment_points);
  },

  /**
   * Resolve attachment transform with proper layering:
   * 1. Child's attachment_point_overrides[parentId] (highest priority)
   * 2. Parent's attachment_points[slotName]
   * 3. Global fallback anchors
   * 4. DEFAULT_ATTACHMENT_TRANSFORMS (lowest priority)
   *
   * This no longer normalizes scale, passing floats or arrays directly to applyTransform.
   */
  resolveAttachmentTransform({
    parentConfig,              // equipped base item config (may have attachment_points)
    childConfig,               // child item config (may have attachment_point_overrides)
    parentId,                  // e.g. "head_rotation_2024_knight"
    slotPath,                  // e.g. "head/hat", "body/badge/left"
    globalFallbackAnchors      // object mapping slotPath -> {pos/rot/scale}
  }) {
    const pick = (obj) => (obj && typeof obj === 'object' ? obj : null);

    // Extract the slot name from the path (e.g., "hat" from "head/hat")
    const getSlotName = (path) => {
      const parts = path.split('/');
      return parts.slice(1).join('/'); // Remove first part (parent type)
    };

    // --- 1) From child's attachment_point_overrides (HIGHEST PRIORITY)
    const getFromChildOverride = () => {
      if (!childConfig || !childConfig.attachment_point_overrides) return null;
      return pick(childConfig.attachment_point_overrides[parentId]);
    };

    // --- 2) From parent's attachment_points
    const getFromParentAnchors = () => {
      if (!parentConfig || !parentConfig.attachment_points) return null;
      const slotName = getSlotName(slotPath);
      if (!slotName) return null;

      // Navigate through nested structure (e.g., "glasses/mouth")
      const parts = slotName.split('/');
      let current = parentConfig.attachment_points;

      for (const part of parts) {
        if (!current || typeof current !== 'object') return null;
        current = current[part];
      }

      return pick(current);
    };

    // --- 3) From global fallback JSON
    const getFromGlobalFallback = () => pick(globalFallbackAnchors && globalFallbackAnchors[slotPath]);

    // --- 4) From hardcoded defaults (LOWEST PRIORITY)
    const getFromDefaultAttachment = () => pick(MeshUtils.DEFAULT_ATTACHMENT_TRANSFORMS[slotPath]);

    const overrideLayer = getFromChildOverride();
    const parentLayer = getFromParentAnchors();
    const globalLayer = getFromGlobalFallback();
    const defaultLayer = getFromDefaultAttachment();

    // Merge fields with priority: override > parent > global > default
    const mergeField = (field, def) => {
      // Check each layer in priority order
      if (overrideLayer && overrideLayer[field] !== undefined) {
        return overrideLayer[field];
      }
      if (parentLayer && parentLayer[field] !== undefined) {
        return parentLayer[field];
      }
      if (globalLayer && globalLayer[field] !== undefined) {
        return globalLayer[field];
      }
      if (defaultLayer && defaultLayer[field] !== undefined) {
        return defaultLayer[field];
      }
      return def;
    };

    // --- MODIFIED ---
    // Removed normalizeScale. We now default to 1.0 (float) and let
    // applyTransform handle either the float or an array from the config.
    const finalTransform = {
      position: mergeField('position', [0, 0, 0]),
      rotation: mergeField('rotation', [0, 0, 0]),
      scale: mergeField('scale', 1.0) // Default to float 1.0
    };
    // --- END MODIFICATION ---

    return finalTransform;
  },

  getAttachmentTransform(childConfig, parentModel, slotPath, parentConfig, globalFallbackAnchors) {
    // Get the parent's actual item ID/name for override lookup
    const parentId = parentConfig && parentConfig.name
      ? parentConfig.name
      : (parentModel && parentModel.name)
      ? parentModel.name
      : null;

    // The 'resolveAttachmentTransform' function already correctly computes
    // the final local transform by layering overrides > parent anchors > globals > defaults.
    const finalTransform = this.resolveAttachmentTransform({
      parentConfig,
      childConfig,
      parentId,
      slotPath,
      globalFallbackAnchors
    });

    return finalTransform;
  }
};