class ModelGridComponent {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            columns: options.columns || 3,
            itemSize: options.itemSize || 300,
            gap: options.gap || 20,
            backgroundColor: options.backgroundColor || 0x000000,
            backgroundAlpha: options.backgroundAlpha || 0,
            showInfo: options.showInfo !== false,
            showIndex: options.showIndex !== false,
            widthOffset: options.widthOffset || 0
        };

        this.renderer = null;
        this.scenes = [];
        this.cameras = [];
        this.models = [];
        this.gridItems = [];
        this.viewports = [];

        this.canvas = null;
        this.grid = null;

        
        this._rects = [];
        this._dirty = true;

        
        this._onResize = null;
        this._onScroll = null;

        this.init();
    }

    init() {
        this.container.className = 'model-grid-container';
        this.container.innerHTML = `
            <canvas class="model-grid-canvas"></canvas>
            <div class="model-grid"></div>
        `;

        this.canvas = this.container.querySelector('.model-grid-canvas');
        this.grid = this.container.querySelector('.model-grid');

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true
        });

        
        this.renderer.setSize(this.grid.scrollWidth, this.grid.scrollHeight, false);
        this.renderer.setClearColor(this.options.backgroundColor, this.options.backgroundAlpha);
        this.renderer.setScissorTest(true);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        this.updateGridLayout(); 

        
        this._onResize = this.handleResize.bind(this);
        this._onScroll = this.handleScroll.bind(this);

        window.addEventListener('resize', this._onResize);
        
        this.grid.addEventListener('scroll', this._onScroll);

        this.startRenderLoop();
        this.showEmptyState();
    }

    addModel(model, name = 'Model', options = {}) {
        if (!model || !model.isObject3D) {
            console.warn('ModelGridComponent: Invalid model provided...');
            return;
        }

        this.hideEmptyState();
        const modelClone = model.clone();
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);

        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(1, 1, 1);
        directionalLight.castShadow = true;
        scene.add(ambientLight, directionalLight);

        this.processModel(modelClone);

        if (options.rotation) {
            modelClone.rotation.set(0, 0, 0);
            const [rx, ry, rz] = options.rotation.map(Number);
            modelClone.rotation.set(
                ry * (Math.PI / 180),
                rx * (Math.PI / 180),
                rz * (Math.PI / 180)
            );
        }

        const boundingBox = new THREE.Box3().setFromObject(modelClone);
        const boundingSphere = new THREE.Sphere();
        boundingBox.getBoundingSphere(boundingSphere);

        const fovInRadians = THREE.MathUtils.degToRad(camera.fov);
        const distance = boundingSphere.radius / Math.tan(fovInRadians / 2);

        camera.position.z = distance * 1.5;
        scene.add(modelClone);

        const gridItem = this.createGridItem(name, this.models.length);

        
        if (options.onClick) {
            gridItem.style.cursor = 'pointer';
            gridItem.addEventListener('click', (e) => {
                e.stopPropagation(); 
                options.onClick(e);
            });
            gridItem.title = "Click to equip"; 
        }
        

        const modelData = {
            scene: modelClone,
            originalModel: model,
            name: name,
            options: options
        };

        this.scenes.push(scene);
        this.cameras.push(camera);
        this.models.push(modelData);

        this.viewports.push({
            scene: scene,
            camera: camera,
            element: gridItem,
            modelIndex: this.models.length - 1
        });

        this.updateGridLayout(); 
    }

    addModels(models, names = [], options = []) {
        if (!Array.isArray(models)) {
            console.warn('ModelGridComponent: models must be an array');
            return;
        }
        models.forEach((model, index) => {
            const name = names[index] || `Model ${index + 1}`;
            const modelOptions = options[index] || {};
            this.addModel(model, name, modelOptions);
        });
    }

    removeModel(index) {
        if (index < 0 || index >= this.models.length) {
            console.warn('ModelGridComponent: Invalid model index');
            return;
        }

        this.scenes.splice(index, 1);
        this.cameras.splice(index, 1);
        this.models.splice(index, 1);
        this.viewports.splice(index, 1);

        if (this.gridItems[index]) {
            this.gridItems[index].remove();
            this.gridItems.splice(index, 1);
        }

        for (let i = index; i < this.viewports.length; i++) {
            this.viewports[i].modelIndex = i;
        }

        if (this.models.length === 0) {
            this.showEmptyState();
        }

        this._rebuildRects();
        this._dirty = true;
    }

    addPlaceholder(name, dataset = {}) {
        this.hideEmptyState();

        const gridItem = this.createGridItem(name);
        gridItem.innerHTML += '<div class="model-loading-spinner"></div>';

        for (const key in dataset) {
            gridItem.dataset[key] = dataset[key];
        }

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
        camera.position.z = 5;

        const ambientLight = new THREE.AmbientLight(0x404040, 0.8);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
        directionalLight.position.set(1, 1, 1);
        scene.add(ambientLight, directionalLight);

        this.scenes.push(scene);
        this.cameras.push(camera);
        this.models.push({ name: name, scene: null });
        this.viewports.push({
            scene: scene,
            camera: camera,
            element: gridItem,
            modelIndex: this.models.length - 1
        });

        this.updateGridLayout();
        return gridItem;
    }

    addModelToCell(index, model, name, options = {}) {
        if (index < 0 || index >= this.models.length) return;

        const gridItem = this.gridItems[index];
        const scene = this.scenes[index];
        const camera = this.cameras[index];

        const spinner = gridItem.querySelector('.model-loading-spinner');
        if (spinner) spinner.remove();

        this.processModel(model);
        if (options.rotation) {
            const [rx, ry, rz] = options.rotation.map(Number);
            model.rotation.set(
                ry * (Math.PI / 180),
                rx * (Math.PI / 180),
                rz * (Math.PI / 180)
            );
        }

        const box = new THREE.Box3().setFromObject(model);
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        const distance = sphere.radius / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        camera.position.z = distance * 1.5;

        scene.add(model);
        this.models[index] = {
            scene: model,
            name: name,
            options: options
        };

        this._rebuildRects();
        this._dirty = true;
    }

    clearAll() {
        this.scenes = [];
        this.cameras = [];
        this.models = [];
        this.viewports = [];

        this.grid.innerHTML = '';
        this.gridItems = [];
        this._rects = [];

        this.showEmptyState();
        this._dirty = true;
    }

    updateConfig(newOptions) {
        Object.assign(this.options, newOptions);
        this.updateGridLayout();
    }

    processModel(model) {
        const boundingBox = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();
        boundingBox.getCenter(center);
        model.position.sub(center);

        model.traverse((child) => {
            if (child.isMesh) {
                if (!child.material) {
                    child.material = new THREE.MeshPhongMaterial({ color: 0x888888 });
                }
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
    }

    createGridItem(name) {
        const gridItem = document.createElement('div');
        gridItem.className = 'model-grid-item';
        gridItem.style.width = this.options.itemSize + 'px';
        gridItem.style.height = this.options.itemSize + 'px';

        if (this.options.showInfo) {
            const info = document.createElement('h3');
            info.className = 'model-info';
            info.textContent = name;
            gridItem.appendChild(info);
        }

        this.grid.appendChild(gridItem);
        this.gridItems.push(gridItem);
        return gridItem;
    }

    updateGridLayout() {
        const columns = this.options.columns;
        const itemSize = this.options.itemSize;
        const gap = this.options.gap;

        
        this.grid.style.display = 'grid';
        this.grid.style.gridTemplateColumns = `repeat(${columns}, ${itemSize}px)`;
        this.grid.style.gap = gap + 'px';

        this.gridItems.forEach(item => {
            item.style.width = itemSize + 'px';
            item.style.height = itemSize + 'px';
        });

        
        this.renderer.setSize(this.grid.scrollWidth + this.options.widthOffset, this.grid.scrollHeight, false);

        
        this._rebuildRects();
        this._dirty = true;
    }

    showEmptyState() {
        if (this.models.length === 0) {
            this.grid.innerHTML = '<div class="empty-state">Select a player cosmetic to see preview scene\'s.</div>';
            this.gridItems = [];
            this._rects = [];
        }
    }

    showLoadingState() {
        this.grid.innerHTML = '<div class="loading-state">🚀 Loading items...</div>';
    }

    hideEmptyState() {
        const emptyState = this.grid.querySelector('.empty-state, .loading-state');
        if (emptyState) emptyState.remove();
    }

    
    handleResize() {
        this.renderer.setSize(this.grid.scrollWidth, this.grid.scrollHeight, false);
        this._rebuildRects(); 
        this._dirty = true;
    }

    
    handleScroll() {
        
        this._dirty = true;
    }

    
   _rebuildRects() {
    const anchor = this.grid.getBoundingClientRect();
    this._rects = this.gridItems.map(el => {
        
        if (el.style.display === 'none' || el.dataset.hidden === 'true') {
            return null;
        }
        const r = el.getBoundingClientRect();
        return {
            left: r.left - anchor.left,
            top: r.top - anchor.top,
            width: r.width,
            height: r.height
        };
    });
}

    startRenderLoop() {
        const render = () => {
            requestAnimationFrame(render);
            if (!this._dirty) return;
            this._dirty = false;
            this.render();
        };
        render();
    }

    render() {
    const canvasWidth = this.grid.scrollWidth;
    const canvasHeight = this.grid.scrollHeight;

    if (this.canvas.width !== canvasWidth || this.canvas.height !== canvasHeight) {
        this.renderer.setSize(canvasWidth, canvasHeight, false);
    }

    this.renderer.setViewport(0, 0, canvasWidth, canvasHeight);
    this.renderer.setScissor(0, 0, canvasWidth, canvasHeight);
    this.renderer.clear();

    const scrollX = this.grid.scrollLeft | 0;
    const scrollY = this.grid.scrollTop | 0;

    for (let i = 0; i < this.viewports.length; i++) {
        const viewport = this.viewports[i];
        const rect = this._rects[i];
        if (!rect) continue;

        
        if (viewport.element.dataset.hidden === 'true' || 
            viewport.element.style.display === 'none') {
            continue;
        }

        
        const left = rect.left - scrollX;
        const top = rect.top - scrollY;
        const width = rect.width;
        const height = rect.height;

        
        if (top + height < 0 || top > canvasHeight || left + width < 0 || left > canvasWidth) {
            continue;
        }

        const vx = left;
        const vy = canvasHeight - (top + height);

        this.renderer.setViewport(vx, vy, width, height);
        this.renderer.setScissor(vx, vy, width, height);

        viewport.camera.aspect = width / height;
        viewport.camera.updateProjectionMatrix();

        this.renderer.render(viewport.scene, viewport.camera);
    }
}

    getModelCount() {
        return this.models.length;
    }

    getModel(index) {
        return this.models[index] || null;
    }

    destroy() {
        if (this._onResize) window.removeEventListener('resize', this._onResize);
        if (this._onScroll) this.grid.removeEventListener('scroll', this._onScroll);
        this.renderer.dispose();
        this.container.innerHTML = '';
        this._rects = [];
    }
}

window.ModelGridComponent = ModelGridComponent;