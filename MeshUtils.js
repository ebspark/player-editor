// ===============================================
// MeshUtils.js (Fixed)
// 1. JSON-driven attachment resolution
// 2. Added "Original Material" restoration logic
// 3. FIXED: Prevent parent material edits from bleeding into child items
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

  applyTransform(object3D, grabTransform = {}) {
    if (!grabTransform) return;

    object3D.position.set(0, 0, 0);
    object3D.rotation.set(0, 0, 0);
    object3D.scale.set(1, 1, 1); 

    if (grabTransform.position) {
      object3D.position.set(...grabTransform.position);
    }

    if (grabTransform.rotation) {
      const radians = grabTransform.rotation.map(deg => THREE.MathUtils.degToRad(deg));
      object3D.rotation.set(radians[1], radians[0], radians[2], 'YXZ');
    }

    if (grabTransform.scale !== undefined && grabTransform.scale !== null) {
      const s = grabTransform.scale;
      if (typeof s === 'number') {
        object3D.scale.multiplyScalar(s); 
      } else if (Array.isArray(s)) {
        object3D.scale.set(...s); 
      }
    }

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

  // === HELPER: Check if a mesh belongs to the current group or a child item ===
  _isMeshOwnedByGroup(mesh, group) {
      let parent = mesh.parent;
      while (parent && parent !== group) {
          // If we hit an object that is an item (and not the root group), 
          // then this mesh belongs to that child item.
          if (parent.userData.isItem) return false;
          parent = parent.parent;
      }
      return true;
  },

  applyMaterialIndices(group, itemConfig) {
    if (!itemConfig.materials) return;

    const meshes = [];
    group.traverse(child => {
      // === FIX: Only collect meshes owned by THIS group, not child items ===
      if (child.isMesh && this._isMeshOwnedByGroup(child, group)) {
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
      default: () => null, 
      
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
      // === FIX: Verify ownership before applying colors ===
      if (!this._isMeshOwnedByGroup(obj, group)) return;

      if (obj.isMesh && colorMap[obj.name] && obj.userData.materialIndex !== undefined) {
        
        if (!obj.userData.originalMaterial) {
            obj.userData.originalMaterial = obj.material;
        }

        const color = colorMap[obj.name](obj.userData.materialIndex);

        if (color) {
          if (obj.material === obj.userData.originalMaterial) {
             obj.material = new THREE.MeshStandardMaterial();
          }
          obj.material.color.set(color);
        } else {
            obj.material = obj.userData.originalMaterial;
        }
      }
    });
  },

  halfColor(color) {
    return color.clone().multiplyScalar(0.5);
  },

  getSlotPath(childType, childConfig) {
    const typeParts = childType.split('/');
    let slotPath;

    if (childType.startsWith('grapple/hook/')) {
        const side = typeParts.pop();
        slotPath = `rope/${side}/end`;
    } else if (childType === 'checkpoint') {
        slotPath = 'checkpoint'; 
    } else {
        const parentType = typeParts[0];
        const sub = typeParts.slice(1).join('/');
        slotPath = `${parentType}/${sub}`; 
        if (childConfig && childConfig.attachment_point) {
            slotPath = `${parentType}/${typeParts[1]}/${childConfig.attachment_point}`; 
        }
    }
    return slotPath;
  },

  createAttachmentSockets(modelGroup, itemConfig) {
    if (!itemConfig || !itemConfig.attachment_points) return;

    Object.entries(itemConfig.attachment_points).forEach(([key, val]) => {
      if (val && typeof val === 'object' && (val.position || val.rotation || val.scale)) {
        let socket = modelGroup.children.find(c => c.name === key && c.userData && c.userData.isSocket);
        if (!socket) {
            socket = new THREE.Object3D();
            socket.name = key; 
            socket.userData.isSocket = true;
            modelGroup.add(socket);
        }
        this.applyTransform(socket, val);
      }
    });
  },

  resolveAttachmentTransform({
    parentConfig,              
    childConfig,               
    parentId,                  
    slotPath,                  
    globalFallbackAnchors      
  }) {
    const pick = (obj) => (obj && typeof obj === 'object' ? obj : null);

    const getSlotName = (path) => {
      const parts = path.split('/');
      return parts.slice(1).join('/'); 
    };

    const getFromChildOverride = () => {
      if (!childConfig || !childConfig.attachment_point_overrides) return null;
      return pick(childConfig.attachment_point_overrides[parentId]);
    };

    const getFromParentAnchors = () => {
      if (!parentConfig || !parentConfig.attachment_points) return null;
      const slotName = getSlotName(slotPath); 
      if (!slotName) return null;
      const attachmentData = parentConfig.attachment_points[slotName];
      return pick(attachmentData);
    };

    const getFromGlobalFallback = () => pick(globalFallbackAnchors && globalFallbackAnchors[slotPath]);

    const getFromDefaultAttachment = () => pick(MeshUtils.DEFAULT_ATTACHMENT_TRANSFORMS[slotPath]);

    const overrideLayer = getFromChildOverride();
    const parentLayer = getFromParentAnchors();
    const globalLayer = getFromGlobalFallback();
    const defaultLayer = getFromDefaultAttachment();

    const mergeField = (field, def) => {
      if (overrideLayer && overrideLayer[field] !== undefined) return overrideLayer[field];
      if (parentLayer && parentLayer[field] !== undefined) return parentLayer[field];
      if (globalLayer && globalLayer[field] !== undefined) return globalLayer[field];
      if (defaultLayer && defaultLayer[field] !== undefined) return defaultLayer[field];
      return def;
    };

    const finalTransform = {
      position: mergeField('position', [0, 0, 0]),
      rotation: mergeField('rotation', [0, 0, 0]),
      scale: mergeField('scale', 1.0) 
    };

    return finalTransform;
  },

  getAttachmentTransform(childConfig, parentModel, slotPath, parentConfig, globalFallbackAnchors) {
    const parentId = parentConfig && parentConfig.name
      ? parentConfig.name
      : (parentModel && parentModel.name)
      ? parentModel.name
      : null;

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