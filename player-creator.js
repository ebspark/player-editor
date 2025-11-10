import { MeshUtils } from './MeshUtils.js';

const playerCreator = {
    
    active: false,
    popup: null,
    previewScene: null,
    previewCamera: null,
    previewRenderer: null,
    previewControls: null,
    previewPlayer: null,
    itemGrid: null,
    primaryColorInput: null,
    secondaryColorInput: null,
    doneButton: null,
    targetPlayer: null,
    isInitialized: false,
    modelCache: {},
    dualSlotBaseTypes: ['body/badge', 'grapple/hook'],

    init() {
        if (this.isInitialized) return;
        this.popup = document.getElementById('createPlayerPopup');
        const previewContainer = document.getElementById('playerPreviewContainer');
        const gridContainer = document.getElementById('playerItemGrid');

        
        this.previewScene = new THREE.Scene();
        this.previewScene.background = new THREE.Color(0x333842);

        this.previewCamera = new THREE.PerspectiveCamera(75, 1.0, 0.1, 100);
        this.previewCamera.position.set(0, 0, 3);

        this.previewRenderer = new THREE.WebGLRenderer({
            antialias: true
        });
        previewContainer.appendChild(this.previewRenderer.domElement);

        this.previewControls = new THREE.OrbitControls(this.previewCamera, this.previewRenderer.domElement);
        this.previewControls.target.set(0, 0, 0);
        this.previewControls.enableDamping = true;

        
        const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
        directionalLight.position.set(2, 5, 3);
        this.previewScene.add(ambientLight, directionalLight);

        
        this.itemGrid = new ModelGridComponent(gridContainer, {
            columns: 4,
            itemSize: 130,
            gap: 15
        });

        
        this.primaryColorInput = document.getElementById('primaryColor');
        this.secondaryColorInput = document.getElementById('secondaryColor');
        this.doneButton = document.getElementById('playerDoneButton');

        
        this.primaryColorInput.addEventListener('input', () => this.updateColors());
        this.secondaryColorInput.addEventListener('input', () => this.updateColors());
        this.doneButton.addEventListener('click', () => this.onDone());

        this.isInitialized = true;
    },

    resizePreview() {
        const previewContainer = document.getElementById('playerPreviewContainer');
        const {
            clientWidth: width,
            clientHeight: height
        } = previewContainer;

        if (width > 0 && height > 0) {
            this.previewCamera.aspect = width / height;
            this.previewCamera.updateProjectionMatrix();
            this.previewRenderer.setSize(width, height);
        }
    },

    animatePreview() {
        if (!this.active) return;
        requestAnimationFrame(() => this.animatePreview());
        if (this.previewControls) this.previewControls.update();
        this.previewRenderer.render(this.previewScene, this.previewCamera);
    },

    async open(playerToEdit = null) {
        this.init();
        this.active = true;
        this.targetPlayer = playerToEdit;

        this.popup.style.display = 'flex';
        this.resizePreview();

        if (this.previewPlayer) {
            this.previewPlayer.dispose();
        }

        const config = this.getConfigFromPlayer(playerToEdit);
        this.primaryColorInput.value = '#' + config.colors.primary.getHexString();
        this.secondaryColorInput.value = '#' + config.colors.secondary.getHexString();

        this.previewPlayer = new Player(this.previewScene, window.shopItems, config);
        await this.previewPlayer.ready;

        if (this.itemGrid.getModelCount() === 0) {
            await this.populateGrid();
        }
        this.updateGridSelectionStates();

        this.animatePreview();
    },

    close() {
        this.popup.style.display = 'none';
        this.active = false;
        if (this.previewPlayer) {
            this.previewPlayer.dispose();
            this.previewPlayer = null;
        }
        this.targetPlayer = null;
    },

    async loadGridItemOnDemand(gridItemEl) {
        const itemId = gridItemEl.dataset.itemId;

        if (gridItemEl.dataset.loaded === "true" || gridItemEl.dataset.loading === "true") {
            return;
        }
        gridItemEl.dataset.loading = "true";

        let modelData;
        if (this.modelCache[itemId]) {
            
            modelData = this.modelCache[itemId].clone(true);
        } else {
            const itemConfig = window.shopItems[itemId];
            if (!itemConfig || !itemConfig.file) {
                gridItemEl.dataset.loading = "false";
                return;
            }

            try {
                const sgmLoader = new SGMLoader();
                const loadedSgm = await sgmLoader.loadAsync(itemConfig.file);
                modelData = loadedSgm.group;
                
                this.modelCache[itemId] = modelData;
                modelData = modelData.clone(true);
            } catch (e) {
                console.warn(`Failed to lazy-load ${itemId}`, e);
                gridItemEl.dataset.loading = "false";
                return;
            }
        }

        if (modelData) {
            const itemConfig = window.shopItems[itemId];
            const primary = new THREE.Color(this.primaryColorInput.value);
            const secondary = new THREE.Color(this.secondaryColorInput.value);

            MeshUtils.applyMaterialIndices(modelData, itemConfig);
            MeshUtils.applyPlayerColors(modelData, itemConfig, primary, secondary);

            const gridIndex = parseInt(gridItemEl.dataset.gridIndex, 10);
            this.itemGrid.addModelToCell(gridIndex, modelData, itemConfig.title, {
                rotation: itemConfig.preview_rotation
            });

            gridItemEl.dataset.loaded = "true";
        }
        gridItemEl.dataset.loading = "false";
    },

    async populateGrid() {
        if (this.itemGrid.getModelCount() > 0) return;

        this.itemGrid.showLoadingState();

        const modelsToLoad = Object.entries(window.shopItems)
            .filter(([, item]) => item.file && !item.not_equippable)
            .map(([id, item]) => ({ id, ...item }));

        this.itemGrid.clearAll();

        modelsToLoad.forEach((item, index) => {
            const placeholderEl = this.itemGrid.addPlaceholder(item.title, {
                itemId: item.id,
                itemType: item.type,
                gridIndex: index
            });

            this._setupGridItemControls(placeholderEl, item);
        });

        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    this.loadGridItemOnDemand(entry.target);
                }
            });
        }, {
            root: document.querySelector('.item-selection-panel'),
            rootMargin: "400px"
        });
        this.itemGrid.gridItems.forEach(el => observer.observe(el));

        this.updateGridSelectionStates();
    },

    _setupGridItemControls(gridItemEl, itemData) {
        gridItemEl.classList.remove('has-controls');

        if (this.dualSlotBaseTypes.includes(itemData.type)) {
            gridItemEl.classList.add('has-controls');

            const controlsDiv = document.createElement('div');
            controlsDiv.className = 'item-controls';

            const leftBtn = document.createElement('button');
            leftBtn.textContent = 'L';
            leftBtn.dataset.slot = 'left';
            leftBtn.onclick = (e) => {
                e.stopPropagation();
                this.handleItemToggle(itemData.id, `${itemData.type}/left`);
            };

            const rightBtn = document.createElement('button');
            rightBtn.textContent = 'R';
            rightBtn.dataset.slot = 'right';
            rightBtn.onclick = (e) => {
                e.stopPropagation();
                this.handleItemToggle(itemData.id, `${itemData.type}/right`);
            };

            controlsDiv.appendChild(leftBtn);
            controlsDiv.appendChild(rightBtn);
            gridItemEl.appendChild(controlsDiv);

        } else {
            gridItemEl.addEventListener('click', () => {
                this.handleItemToggle(itemData.id, itemData.type);
            });
        }
    },

    async handleItemToggle(itemId, specificItemType) {
        if (!this.previewPlayer) return;

        const isCurrentlyEquipped = this.previewPlayer.activeModels[specificItemType]?.name === itemId;

        if (isCurrentlyEquipped) {
            
            await this.previewPlayer.unequipItem(specificItemType);
            
            
            const defaultConfig = this.previewPlayer.defaults[specificItemType];
            if (defaultConfig) {
                
                const defaultItemName = specificItemType;
                await this.previewPlayer.equipItem(defaultItemName, specificItemType);
            }
        } else {
            await this.previewPlayer.equipItem(itemId, specificItemType);
        }

        this.updateGridSelectionStates();
    },

    updateGridSelectionStates() {
        if (!this.previewPlayer) return;

        this.itemGrid.gridItems.forEach(itemEl => {
            const itemId = itemEl.dataset.itemId;
            const itemType = itemEl.dataset.itemType;

            itemEl.classList.remove('equipped');

            if (this.dualSlotBaseTypes.includes(itemType)) {
                const leftBtn = itemEl.querySelector('button[data-slot="left"]');
                const rightBtn = itemEl.querySelector('button[data-slot="right"]');
                let isEquippedLeft = false;
                let isEquippedRight = false;

                if (this.previewPlayer.activeModels[`${itemType}/left`]?.name === itemId) {
                    isEquippedLeft = true;
                }
                if (this.previewPlayer.activeModels[`${itemType}/right`]?.name === itemId) {
                    isEquippedRight = true;
                }

                if (leftBtn) leftBtn.classList.toggle('equipped', isEquippedLeft);
                if (rightBtn) rightBtn.classList.toggle('equipped', isEquippedRight);

                if (isEquippedLeft || isEquippedRight) {
                    itemEl.classList.add('equipped');
                }

            } else {
                if (this.previewPlayer.activeModels[itemType]?.name === itemId) {
                    itemEl.classList.add('equipped');
                }
            }
        });
    },

    updateColors() {
        if (!this.previewPlayer) return;
        const primary = new THREE.Color(this.primaryColorInput.value);
        const secondary = new THREE.Color(this.secondaryColorInput.value);

        const playerData = this.previewPlayer.scene.userData[this.previewPlayer.userInput];
        playerData.primary_color.set(primary);
        playerData.secondary_color.set(secondary);

        for (const itemType in this.previewPlayer.activeModels) {
            const model = this.previewPlayer.activeModels[itemType];
            const config = window.shopItems[model.name] || this.previewPlayer.defaults[itemType] || {};
            MeshUtils.applyPlayerColors(model, config, primary, secondary);
        }

        if (this.itemGrid && this.itemGrid.getModelCount() > 0) {
            this.itemGrid.gridItems.forEach((gridItemEl, index) => {
                const itemId = gridItemEl.dataset.itemId;
                const itemConfig = window.shopItems[itemId];
                const modelData = this.itemGrid.getModel(index);

                if (itemConfig && modelData && modelData.scene) {
                    MeshUtils.applyPlayerColors(modelData.scene, itemConfig, primary, secondary);
                }
            });
        }
    },

    async onDone() {
        const equippedItems = {};
        
        
        for (const itemType in this.previewPlayer.activeModels) {
            const model = this.previewPlayer.activeModels[itemType];
            const itemId = model.name;
            
            
            const defaultConfig = this.previewPlayer.defaults[itemType];
            if (defaultConfig && itemId === itemType) {
                continue; 
            }
            
            equippedItems[itemType] = itemId;
        }

        const finalConfig = {
            initialItems: equippedItems,
            colors: {
                primary: new THREE.Color(this.primaryColorInput.value),
                secondary: new THREE.Color(this.secondaryColorInput.value)
            }
        };

        console.log('Final config to apply:', finalConfig);

        if (this.targetPlayer) {
            
            const player = this.targetPlayer;
            player.scene.userData[player.userInput].primary_color.set(finalConfig.colors.primary);
            player.scene.userData[player.userInput].secondary_color.set(finalConfig.colors.secondary);

            
            (async () => {
                const currentTypes = Object.keys(player.activeModels);
                for (const type of currentTypes) {
                    await player.unequipItem(type);
                }
                await player.initializePlayer(finalConfig.initialItems);
            })();
        } else {
            
            let player = new Player(scene, window.shopItems, finalConfig);
            await player.ready;
            transformControls.attach(player.root);
        }

        this.close();
    },

    getConfigFromPlayer(playerInstance) {
        if (!playerInstance) {
            return {
                initialItems: {},
                colors: {
                    primary: new THREE.Color(document.getElementById('primaryColor').value),
                    secondary: new THREE.Color(document.getElementById('secondaryColor').value)
                }
            };
        }

        const playerData = playerInstance.scene.userData[playerInstance.userInput];
        const items = {};
        
        for (const type in playerInstance.activeModels) {
            const model = playerInstance.activeModels[type];
            const itemId = model.name;
            
            
            const defaultConfig = playerInstance.defaults[type];
            if (!defaultConfig || itemId !== type) {
                items[type] = itemId;
            }
        }

        return {
            initialItems: items,
            colors: {
                primary: playerData.primary_color.clone(),
                secondary: playerData.secondary_color.clone(),
            }
        };
    }
};

function createPlayer() {
    playerCreator.open();
}

function closeCreatePlayerPopup() {
    playerCreator.close();
}

function editSelectedPlayer() {
    if (selectedPlayer) {
        playerCreator.open(selectedPlayer);
    }
}

function filterPlayerItems() {
    const searchTerm = document.getElementById('playerItemSearch').value.toLowerCase();
    if (!playerCreator.itemGrid) return;

    playerCreator.itemGrid.gridItems.forEach((itemElement) => {
        const itemId = itemElement.dataset.itemId;
        const itemConfig = window.shopItems[itemId];
        
        if (itemConfig) {
            const isVisible = 
                itemId.toLowerCase().includes(searchTerm) || 
                (itemConfig.title && itemConfig.title.toLowerCase().includes(searchTerm));
            
            itemElement.style.display = isVisible ? 'flex' : 'none';
            
            itemElement.dataset.hidden = isVisible ? 'false' : 'true';
        }
    });
    
    
    playerCreator.itemGrid._rebuildRects();
    playerCreator.itemGrid._dirty = true;
}
window.createPlayer = createPlayer;
window.closeCreatePlayerPopup = closeCreatePlayerPopup;
window.editSelectedPlayer = editSelectedPlayer;
window.filterPlayerItems = filterPlayerItems;