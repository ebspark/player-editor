

async function addItem() {
    const popup = document.getElementById('itemPopup');
    const gridContainer = document.getElementById('itemGrid');
    popup.style.display = 'flex';

    if (genericItemGrid && genericItemGrid.getModelCount() > 0) {
        return;
    }

    if (!genericItemGrid) {
        genericItemGrid = new ModelGridComponent(gridContainer, {
            columns: 5,
            itemSize: 120,
            gap: 10
        });
    }

    genericItemGrid.showLoadingState();

    try {
        const sgmLoader = new SGMLoader();
        const modelsToLoad = Object.values(window.shopItems)
            .filter(item => item.file);

        const loadedModels = await Promise.all(modelsToLoad.map(itemData =>
            sgmLoader.loadAsync(itemData.file)
                .then(loadedSgm => ({ ...itemData, model: loadedSgm.group }))
                .catch(error => {
                    console.warn(`Could not load model: ${itemData.name}`, error);
                    return null;
                })
        ));

        genericItemGrid.clearAll();

        loadedModels.forEach(loadedItem => {
            if (loadedItem?.model) {
                const modelOptions = {
                    rotation: loadedItem.preview_rotation || null
                };


                genericItemGrid.addModel(loadedItem.model, loadedItem.name, modelOptions);
                const gridItemElement = genericItemGrid.gridItems[genericItemGrid.getModelCount() - 1];

                gridItemElement.addEventListener('click', () => {
                    const modelClone = loadedItem.model.clone();
                    modelClone.name = loadedItem.name;
                    scene.add(modelClone);
                    transformControls.attach(modelClone); 
                    closeItemPopup();
                });
            }
        });
    } catch (error) {
        console.error('Failed to process shop items for addItem:', error);
        gridContainer.innerHTML = '<div class="empty-state">❌ Failed to load items.</div>';
    }
}

function closeItemPopup() {
    const popup = document.getElementById('itemPopup');
    popup.style.display = 'none';
}

function filterItems() {
    const searchTerm = document.getElementById('itemSearch').value.toLowerCase();
    if (!genericItemGrid) return;

    genericItemGrid.gridItems.forEach((itemElement, index) => {
        const modelData = genericItemGrid.getModel(index);
        if (modelData) {
            itemElement.style.display = modelData.name.toLowerCase().includes(searchTerm) ? 'flex' : 'none';
        }
    });
}


