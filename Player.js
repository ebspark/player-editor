// ===============================================
// Player.js (Fixed)
// - JSON-driven global fallbacks
// - Layered transforms (anchors → overrides → fallbacks)
// - Proper parent ID resolution for overrides
// - Fixed: Apply initialTransform based on item TYPE, not just defaults
// ===============================================

import { MeshUtils } from './MeshUtils.js';

class PlayerModelFactory {
  constructor(itemsList, globalFallbackAnchors = {}) {
    this.itemsList = itemsList;
this.dualSlotBaseTypes = new Set(['body/badge', 'grapple/hook']);
    // Global JSON fallbacks (migrated from C++)
    this.globalFallbackAnchors = {
      'head/hat': { position: [0.0, 0.190766, 0.0] },
      'head/glasses': { position: [0.0, 0.008302, -0.203441] },
      'head/glasses/mouth': { position: [0.0, -0.192385, -0.291841] },
      'body/backpack': { position: [0.0, -0.311955, 0.278574] },
      'body/neck': { position: [0, 0, 0] },
      'body/neck/chest': { position: [0.0, -0.300416, -0.124705] },
      'body/badge/left': { position: [-0.134673, -0.267122, -0.088314], rotation: [15.5, -1.24, 0.0] },
      'body/badge/right': { position: [0.134673, -0.267122, -0.088314], rotation: [-15.5, -1.24, 0.0] },
      'body/lower': { position: [0.0, -0.55, 0.1] },
      'checkpoint': { position: [-0.5, -1.5, 0] },
      'rope/left/end': { position: [0, 0, -1] },
      'rope/right/end': { position: [0, 0, -1] }
    };

    // Allow caller to merge/override defaults
    Object.assign(this.globalFallbackAnchors, globalFallbackAnchors || {});

    // Minimal defaults for base parts
    this.defaults = {
      'head': {
        title: 'default_head',
        file: 'player/head', type: 'head',
        materials: [
          { type: 'default_primary_color' },
          { type: 'default_secondary_color' },
          { type: 'default_secondary_color_visor' }
        ],
        initialTransform: { rotation: [180, 0, 0] }
      },
      'body': {
        title: 'default_body',
        file: 'player/body', type: 'body',
        materials: [
          { type: 'default_secondary_color' },
          { type: 'default_primary_color' }
        ],
        initialTransform: { position: [0, -0.2, 0], rotation: [180, 0, 0] }
      },
      'hand/left': {
        title: 'default_hand',
        file: 'player/hand_claw', type: 'hand/left',
        materials: [
          { type: 'default_primary_color' },
          { type: 'default_secondary_color' }
        ],
        initialTransform: { position: [0.3, -0.75, 0.1], rotation: [190.0, -45.0, 0.0] }
      },
      'hand/right': {
        title: 'default_hand',
        file: 'player/hand_claw', type: 'hand/right',
        materials: [
          { type: 'default_primary_color' },
          { type: 'default_secondary_color' }
        ],
        initialTransform: {
          position: [-0.3, -0.5, 0.4],
          rotation: [170.0, -10.0, 0.0],
          scale: [-1.0, 1.0, 1.0]
        }
      },
      'rope/left': {
        title: 'default_rope',
        file: 'player/grapple_rope', type: 'rope/left',
        initialTransform: { position: [0.3, -0.75, 0.1], rotation: [190.0, -45.0, 0.0] }
      },
      'rope/right': {
        title: 'default_rope',
        file: 'player/grapple_rope', type: 'rope/right',
        initialTransform: { position: [-0.3, -0.5, 0.4], rotation: [170.0, -10.0, 0.0] }
      },
      'checkpoint': {
        title: 'default_checkpoint',
        file: 'player/checkpoint', type: 'checkpoint',
        initialTransform: { position: [-0.5, -1.5, 0] }
      },
      'grapple/hook/left': {
        title: 'default_grapple_hook',
         file: 'player/grapple_anchor', type: 'grapple/hook/left' },
      'grapple/hook/right': { 
        title: 'default_grapple_hook',
        file: 'player/grapple_anchor', type: 'grapple/hook/right' }
    };

    // Seed defaults into shopItems
    if (!window.shopItems) window.shopItems = {};
    for (const [itemType, config] of Object.entries(this.defaults)) {
      if (!window.shopItems[itemType]) {
        window.shopItems[itemType] = { ...config };
      }
    }

    this.loader = new SGMLoader();
  }

  async create(options) {
    const { itemName, itemType, colors } = options;

    // Always pull from shopItems
    const itemConfig = window.shopItems[itemName];
    if (!itemConfig) throw new Error(`No shop config found for itemName=${itemName}`);

    const loadedAsset = await this.loader.loadAsync(itemConfig.file);
    const modelGroup = loadedAsset.group;

    MeshUtils.applyMaterialIndices(modelGroup, itemConfig);
    MeshUtils.applyPlayerColors(modelGroup, itemConfig, colors.primary, colors.secondary);
    MeshUtils.createAttachmentSockets(modelGroup, itemConfig);

    // CRITICAL FIX: Apply initialTransform based on item TYPE
    // If the item config has its own initialTransform, use that
    // Otherwise, use the default transform for this item TYPE
    let transformToApply = itemConfig.initialTransform;
    
    if (!transformToApply) {
      // Check if there's a default transform for this item type
      const defaultForType = this.defaults[itemType];
      if (defaultForType && defaultForType.initialTransform) {
        transformToApply = defaultForType.initialTransform;
      }
    }

    if (transformToApply) {
      MeshUtils.applyTransform(modelGroup, transformToApply);
      console.log('Applied initialTransform for', itemName, 'type', itemType, ':', transformToApply);
    }

    modelGroup.name = itemName;
    modelGroup.userData = {
      itemKey: itemName,
      isItem: true,
      config: itemConfig
    };

    return {
      modelGroup,
      skeleton: loadedAsset.skeleton,
      clips: loadedAsset.clips
    };
  }
}

class Player {
  static usedPlayerNames = new Set();

  // --- MODIFICATION: Accepts globalModelFactory now ---
  constructor(scene, globalModelFactory, initialConfig = {}) {
    const { initialItems = {}, colors = {}, userInput = undefined } = initialConfig;

    this.scene = scene;
    this.userInput = Player._validatePlayerName(userInput);

    // --- Use the single global factory ---
    this.modelFactory = globalModelFactory;
    this.itemsList = this.modelFactory.itemsList; 
    this.defaults = this.modelFactory.defaults;
    this.globalFallbackAnchors = this.modelFactory.globalFallbackAnchors;
    // --- END MODIFICATION ---

    this.root = new THREE.Group();
    this.root.name = this.userInput;
    this.root.userData.isPlayer = true;
    this.root.userData.playerInstance = this;
    this.scene.add(this.root);

    this.activeModels = {};
    this.pendingAttachments = {};
    this.skeleton = null;

    // --- REMOVED: this.modelFactory = new PlayerModelFactory(...) ---

    this.scene.userData[this.userInput] = {
      primary_color: colors.primary || new THREE.Color(0x00ff00),
      secondary_color: colors.secondary || new THREE.Color(0xff0000),
      playerInstance: this,
    };

    // --- REMOVED: this.globalFallbackAnchors = this.modelFactory.globalFallbackAnchors; ---

    this.ready = this.initializePlayer(initialItems);
  }

  static _validatePlayerName(name) {
    let uniqueName = name || 'defaultPlayer';
    let counter = 1;
    while (Player.usedPlayerNames.has(uniqueName)) {
      uniqueName = `player_${counter++}`;
    }
    Player.usedPlayerNames.add(uniqueName);
    return uniqueName;
  }

  async initializePlayer(initialItems = {}) {
    // Spawn base defaults first
    const defaultPromises = [];
    for (const itemType in this.defaults) {
      if (!initialItems[itemType]) {
        console.log(itemType);
        const itemName = itemType;
        defaultPromises.push(this.equipItem(itemName, itemType));
      }
    }
    await Promise.all(defaultPromises);

    // Then equip user-specified items
    const initialItemPromises = [];
    for (const itemType in initialItems) {
      console.log(itemType, initialItems[itemType]);
      initialItemPromises.push(this.equipItem(initialItems[itemType], itemType));
    }
    await Promise.all(initialItemPromises);
  }

  async equipItem(itemName, itemType) {
    console.log("Equipping item type: " + itemType + " | item name: " + itemName);
    
    if (itemType === 'hand') {
      await this.unequipItem('hand/left');
      await this.unequipItem('hand/right');
      await Promise.all([
        this.equipItem(itemName, 'hand/left'),
        this.equipItem(itemName, 'hand/right')
      ]);
      return;
    }

    const childrenToReEquip = [];
    const isReplacingBaseItem = !itemType.includes('/') && this.activeModels[itemType];

    if (isReplacingBaseItem) {
      const childKeys = Object.keys(this.activeModels).filter(key => key.startsWith(itemType + '/'));
      for (const key of childKeys) {
        const childModel = this.activeModels[key];
        if (childModel) {
          childrenToReEquip.push({ itemName: childModel.name, itemType: key });
        }
      }
    }

    if (this.activeModels[itemType]) {
      await this.unequipItem(itemType);
    }

    const colors = this.scene.userData[this.userInput];

    const loadedAsset = await this.modelFactory.create({
      itemName,
      itemType,
      colors: { primary: colors.primary_color, secondary: colors.secondary_color }
    });

    const model = loadedAsset.modelGroup;

    if (loadedAsset.skeleton) {
      this.skeleton = loadedAsset.skeleton;
    }

    if (this.skeleton) {
      model.traverse(child => {
        if (child.isSkinnedMesh) {
          child.bind(this.skeleton);
        }
      });
    }

    this.activeModels[itemType] = model;

const rootItemTypes = [
    'head', 
    'body', 
    'hand/left', 
    'hand/right', 
    'rope/left', 
    'rope/right'
];

if (rootItemTypes.includes(itemType)) {
    // This is a base part, attach to root.
    this.root.add(model);
} else {
    // This is a child item (like 'head/hat') OR a special case 
    // (like 'checkpoint' or 'grapple/hook/left') that _attachModel knows how to handle.
    this._attachModel(model, itemType);
}

    this._processPendingAttachmentsFor(itemType);

    if (childrenToReEquip.length > 0) {
      const reEquipPromises = childrenToReEquip.map(item => this.equipItem(item.itemName, item.itemType));
      await Promise.all(reEquipPromises);
    }
  }

  /**
   * Attach child using layered transform resolution (anchors → overrides → JSON fallbacks).
   * Attaches child directly to the parent model (not under socket) to avoid double transforms.
   */
  _attachModel(childModel, childType) {
    const childConfig = window.shopItems[childModel.name] || {};
    const typeParts = childType.split('/');
    let parentType, slotPath;

    if (childType.startsWith('grapple/hook/')) {
      const side = typeParts.pop();
      parentType = `rope/${side}`;
      slotPath = `rope/${side}/end`;
    } else if (childType === 'checkpoint') {
      // Treat checkpoint as a slot attached to root/player
      this.root.add(childModel);
      return;
    } else {
      parentType = typeParts[0];
      const sub = typeParts.slice(1).join('/');
      slotPath = `${parentType}/${sub}`; // e.g. 'head/hat', 'body/badge/left'
      if (childConfig.attachment_point) {
        slotPath = `${parentType}/${typeParts[1]}/${childConfig.attachment_point}`; // e.g. 'head/glasses/mouth'
      }
    }

    const parentModel = this.activeModels[parentType];

    if (parentModel) {
      // CRITICAL: Get parent's config AND its actual item name for override lookup
      const parentConfig = (parentModel.userData && parentModel.userData.config) || {};
      
      // Pass the parent model's name (the actual item ID like "head_rotation_2024_knight")
      // This is used to look up attachment_point_overrides["head_rotation_2024_knight"]
      const parentItemName = parentModel.name;
      
      // Create a modified config that includes the item name for override resolution
      const parentConfigWithId = {
        ...parentConfig,
        name: parentItemName  // This ensures the override lookup works correctly
      };

      const finalTransform = MeshUtils.getAttachmentTransform(
        childConfig,
        parentModel,
        slotPath,
        parentConfigWithId,  // Pass config with the actual item name
        this.globalFallbackAnchors
      );

      console.log(`Attaching ${childModel.name} to ${parentType} (${parentItemName}) at ${slotPath}:`, finalTransform);

      // Apply final transform to child, then attach directly under parent model
      MeshUtils.applyTransform(childModel, finalTransform);

      // Grapple hook offset handling (if defined)
      if (childType.startsWith('grapple/hook/')) {
        const offsetValue = childConfig.attachment_offset_v2;
        if (typeof offsetValue === 'number') {
          childModel.translateZ(-offsetValue);
        } else if (Array.isArray(offsetValue)) {
          childModel.position.add(new THREE.Vector3(offsetValue[0], offsetValue[1], offsetValue[2]));
        }
      }
      
      // --- NEW: Store the slot path on the child for easy access by editors ---
      childModel.userData.slotPath = slotPath;

      parentModel.add(childModel);
    } else {
      if (!this.pendingAttachments[parentType]) this.pendingAttachments[parentType] = [];
      this.pendingAttachments[parentType].push(childType);
    }
  }

  _processPendingAttachmentsFor(parentType) {
    const pendingChildrenTypes = this.pendingAttachments[parentType];
    if (pendingChildrenTypes && pendingChildrenTypes.length > 0) {
      delete this.pendingAttachments[parentType];
      pendingChildrenTypes.forEach(childType => {
        const childModel = this.activeModels[childType];
        if (childModel) {
          this._attachModel(childModel, childType);
        }
      });
    }
  }

  async unequipItem(itemType) {
    if (itemType === 'hand') {
      await Promise.all([
        this.unequipItem('hand/left'),
        this.unequipItem('hand/right')
      ]);
      return;
    }
    const modelToRemove = this.activeModels[itemType];
    if (!modelToRemove) return;
    const childKeys = Object.keys(this.activeModels).filter(key => {
      const model = this.activeModels[key];
      return model && model.parent === modelToRemove;
    });
    for (const key of childKeys) {
      await this.unequipItem(key);
    }
    if (modelToRemove.parent) {
      modelToRemove.parent.remove(modelToRemove);
    }
    delete this.activeModels[itemType];
  }
refreshModel(model) {
    if (!model || !model.userData.isItem) {
      console.warn("Cannot refresh non-item model:", model);
      return;
    }

    const itemName = model.name;
    // Get the config that was just updated by the editor
    const newConfig = model.userData.config || window.shopItems[itemName];

    if (!newConfig) {
      console.warn(`No config found for ${itemName}, skipping refresh.`);
      return;
    }

    // --- 1. Find Item Type ---
    let itemType = null;
    for (const [type, activeModel] of Object.entries(this.activeModels)) {
      if (activeModel === model) {
        itemType = type;
        break;
      }
    }
    if (!itemType) {
      console.warn(`Could not find itemType for ${itemName}, refresh may be incomplete.`);
    }

    // --- 2. Re-apply Materials and Colors ---
    const colors = this.scene.userData[this.userInput];
    MeshUtils.applyMaterialIndices(model, newConfig);
    MeshUtils.applyPlayerColors(model, newConfig, colors.primary_color, colors.secondary_color);

    // --- 3. Re-build Sockets (clear old, add new) ---
    // This immediately updates attachment points on this model
    const oldSockets = model.children.filter(c => c.userData.isSocket);
    oldSockets.forEach(s => model.remove(s));
    MeshUtils.createAttachmentSockets(model, newConfig);

    // --- 4. Refresh This Item's Own Position (if it's a child) ---
    // If we edited a "hat", this re-runs its attachment logic
    // to move it relative to the "head"
    if (itemType && itemType.includes('/')) {
      this._attachModel(model, itemType);
    }

    // --- 5. Refresh Positions of all Children ---
    // If we edited a "body", this finds its children (like "backpack")
    // and re-runs their attachment logic to move them to the new sockets.
    const childItems = model.children.filter(c => c.userData.isItem);
    childItems.forEach(childModel => {
      let childItemType = null;
      for (const [type, activeChildModel] of Object.entries(this.activeModels)) {
        if (activeChildModel === childModel) {
          childItemType = type;
          break;
        }
      }
      if (childItemType) {
        // Re-run attach logic for the child, which will use the
        // parent's (this model's) new socket data.
        this._attachModel(childModel, childItemType);
      }
    });

    console.log(`✅ Refreshed model: ${itemName}`);
  }

  dispose() {
    if (this.root.parent) {
      this.root.parent.remove(this.root);
    }
    Player.usedPlayerNames.delete(this.userInput);
    delete this.scene.userData[this.userInput];
    this.activeModels = {};
  }
}

window.Player = Player;
window.PlayerModelFactory = PlayerModelFactory;

window.MeshUtils = MeshUtils;