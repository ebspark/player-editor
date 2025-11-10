let activeJson = {};
let jsonEditor;

/**
 * Updates the JSON editor to display the configuration for the selected objects.
 * @param {Array<THREE.Object3D>} [selectedObjects=[]] - An array of selected objects.
 */
window.updateJsonEditorContent = (selectedObjects = []) => {
  if (!jsonEditor) {
    return;
  }

  try {
    const dataToShow = {};
    const fallbackTemplate = { title: "", type: "" };
    const processedItemNames = new Set();

    for (const obj of selectedObjects) {
      let targetObj = obj;

      
      if (window.attachmentMode === 'parent' && obj.userData.isItem && obj.parent && obj.parent.userData.isItem && !obj.parent.userData.isPlayer) {
          targetObj = obj.parent;
      }

      const itemObject = targetObj.userData.isItem ? targetObj : targetObj.userData.playerInstance ? targetObj : null;
      
      if (itemObject && itemObject.userData.isPlayer) {
        
        const playerInstance = itemObject.userData.playerInstance;
        if (!playerInstance || !playerInstance.activeModels) continue;
        
        const defaultTypes = Object.keys(playerInstance.modelFactory.defaults);

        for (const [itemType, model] of Object.entries(playerInstance.activeModels)) {
          
          if (defaultTypes.includes(itemType) && model.name === itemType) {
            continue; 
          }
          
          const name = model.name;
          if (name && !processedItemNames.has(name)) {
            processedItemNames.add(name);
            const shopData = window.shopItems ? window.shopItems[name] : undefined;
            if (shopData) {
              
              
              
              dataToShow[name] = JSON.parse(JSON.stringify(shopData));
              
            } else {
              dataToShow[name] = fallbackTemplate;
            }
          }
        }
      } else {
        
        let currentItem = targetObj;
        while (currentItem.parent && !currentItem.userData.isItem && !currentItem.userData.isPlayer) {
          currentItem = currentItem.parent;
        }

        if (!currentItem.userData.isItem) continue;

        
        if (window.attachmentMode === 'parent' && currentItem.parent && currentItem.parent.userData.isItem && !currentItem.parent.userData.isPlayer) {
             currentItem = currentItem.parent;
        }

        const name = currentItem.name;
        if (!name || processedItemNames.has(name)) continue;

        
        let playerInstance = null;
        let parent = currentItem.parent;
        while (parent) {
          if (parent.userData?.isPlayer) {
            playerInstance = parent.userData.playerInstance;
            break;
          }
          parent = parent.parent;
        }

        // --- MODIFICATION: Handle Default Model selection in Parent Mode ---
        const config = currentItem.userData.config || window.shopItems[name];
        if (!config || !config.type) continue;
        
        const isDefaultModel = name === config.type;

        if (window.attachmentMode === 'parent' && isDefaultModel) {
            // User has selected a default model (e.g., "head") in parent mode.
            // Show the global fallbacks related to this parent.
            if (!globalModelFactory) continue;
            
            const parentType = config.type; // e.g., "head"
            const relatedFallbacks = {};
            
            // Find all fallbacks that start with this parent's type
            for (const [slotPath, transform] of Object.entries(globalModelFactory.globalFallbackAnchors)) {
                if (slotPath.startsWith(parentType + '/')) {
                    relatedFallbacks[slotPath] = JSON.parse(JSON.stringify(transform)); // Deep copy
                }
            }
            
            dataToShow[`Global Fallbacks (${parentType})`] = relatedFallbacks;
            processedItemNames.add(name); // Mark as processed
            
        } else {
            // --- ORIGINAL LOGIC ---
            // This is a custom item OR we are in child mode.
            
            // This block hides default items when not in parent mode
            if (playerInstance) {
              let itemType = null;
              for (const [type, model] of Object.entries(playerInstance.activeModels)) {
                if (model === currentItem) {
                  itemType = type;
                  break;
                }
              }
              const defaultTypes = Object.keys(playerInstance.modelFactory.defaults);
              if (itemType && defaultTypes.includes(itemType) && currentItem.name === itemType) {
                continue; 
              }
            }
            
            processedItemNames.add(name);
            const shopData = window.shopItems ? window.shopItems[name] : undefined;
            if (shopData) {
              dataToShow[name] = JSON.parse(JSON.stringify(shopData));
            } else {
              dataToShow[name] = fallbackTemplate;
            }
        }
        // --- END MODIFICATION ---
      }
    }

    const jsonString = JSON.stringify(dataToShow, null, 2);
    if (jsonEditor.getValue() !== jsonString) {
      jsonEditor.setValue(jsonString);
    }
    activeJson = dataToShow;
    
  } catch (e) {
    console.error("Failed to update JSON editor content:", e);
  }
};

/**
 * --- UPDATED FUNCTION ---
 * Parses the editor content and applies changes to the
 * global window.shopItems, global fallbacks, and all active scene models.
 * Now handles saving to `globalModelFactory.globalFallbackAnchors`.
 */
function updateExternalObject() {
    if (!jsonEditor) return;

    let newData;
    try {
        newData = JSON.parse(jsonEditor.getValue());
        
        document.getElementById('json-error-overlay').style.display = 'none';
    } catch (e) {
        
        const errorEl = document.getElementById('json-error-overlay');
        errorEl.textContent = `Invalid JSON: ${e.message}`;
        errorEl.style.display = 'block';
        return; 
    }
    
    
    activeJson = newData;

    
    for (const itemName in newData) {
        if (Object.hasOwnProperty.call(newData, itemName)) {
            
            // --- NEW LOGIC: Handle Global Fallback saving ---
            if (itemName.startsWith('Global Fallbacks (') && globalModelFactory) {
                const fallbackData = newData[itemName];
                
                // Update the global factory with new/modified values
                for (const slotPath in fallbackData) {
                    if (Object.hasOwnProperty.call(fallbackData, slotPath)) {
                        // Update existing or add new
                        globalModelFactory.globalFallbackAnchors[slotPath] = fallbackData[slotPath];
                    }
                }
                
                // Handle deletions:
                // We need to know the parentType to check for deletions
                const parentType = itemName.match(/\(([^)]+)\)/)[1]; // Get 'head' from 'Global Fallbacks (head)'
                if (parentType) {
                    for (const slotPath in globalModelFactory.globalFallbackAnchors) {
                        // If it's a related path but is NO LONGER in the editor, delete it
                        if (slotPath.startsWith(parentType + '/') && !fallbackData.hasOwnProperty(slotPath)) {
                            console.log(`Deleting global fallback: ${slotPath}`);
                            delete globalModelFactory.globalFallbackAnchors[slotPath];
                        }
                    }
                }
                
                // Refresh all players in the scene that are using this default model
                if (window.scene) {
                    window.scene.traverse(object => {
                        if (object.userData?.isPlayer && object.userData.playerInstance) {
                            // Find any model of the parentType and refresh it
                            // This works because refreshing a parent refreshes all its children
                            const parentModel = object.userData.playerInstance.activeModels[parentType];
                            if (parentModel) {
                                object.userData.playerInstance.refreshModel(parentModel);
                            }
                        }
                    });
                }
                
            } else {
                // --- ORIGINAL LOGIC: Handle shopItem saving ---
                const newItemConfig = newData[itemName]; 
                const masterConfig = window.shopItems[itemName];

                if (!masterConfig) {
                     console.warn(`No master config for ${itemName}, creating...`);
                     window.shopItems[itemName] = newItemConfig;
                     
                } else {
                    // Update existing keys
                    for (const key in newItemConfig) {
                        if (Object.hasOwnProperty.call(newItemConfig, key)) {
                            masterConfig[key] = newItemConfig[key];
                        }
                    }
                    
                    // Delete removed keys
                    for (const key in masterConfig) {
                        if (Object.hasOwnProperty.call(masterConfig, key)) {
                            if (!newItemConfig.hasOwnProperty(key)) {
                                console.log(`Deleting key ${key} from ${itemName}`);
                                delete masterConfig[key];
                            }
                        }
                    }
                }

                // Refresh models in scene
                if (window.scene) {
                    window.scene.traverse(object => {
                        
                        if (object.name === itemName && object.userData.isItem) {
                            
                            
                            let playerInstance = null;
                            let cur = object;
                            while (cur.parent) {
                                if (cur.userData?.isPlayer) {
                                    playerInstance = cur.userData.playerInstance;
                                    break;
                                }
                                cur = cur.parent;
                            }

                            
                            if (playerInstance && typeof playerInstance.refreshModel === 'function') {
                                
                                playerInstance.refreshModel(object);
                            } else {
                                
                            }
                        }
                    });
                }
            }
        }
    }
    
    // --- MODIFICATION: Clear preview cache to force refresh ---
    if (window.previewCache) {
        window.previewCache.clear();
        console.log("Cleared preview cache after JSON update.");
    }
    
    // Refresh preview bar
    if (window.updateAttachmentPreview && selectedObjectsForOutline && selectedObjectsForOutline.length > 0) {
        window.updateAttachmentPreview(selectedObjectsForOutline[0]);
    }
}


require.config({ paths: { 'vs': 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.0/min/vs' }});
require(["vs/editor/editor.main"], function () {

  // Define a custom theme
  monaco.editor.defineTheme('custom-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1a1a1a',
      'editorLineNumber.foreground': '#1a1a1a',
      'editorGutter.background': '#1a1a1a'
    }
  });

  const initialJsonString = JSON.stringify({}, null, 2);

    jsonEditor = monaco.editor.create(document.getElementById('jsonEditor'), {
    value: initialJsonString,
    language: "json",
    theme: "custom-dark",
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "off",
    glyphMargin: false,
    lineDecorationsWidth: 10,
    lineNumbersMinChars: 2
  });
  
  // Add an error overlay
  const editorContainer = document.getElementById('jsonEditor');
  const errorOverlay = document.createElement('div');
  errorOverlay.id = 'json-error-overlay';
  errorOverlay.style.cssText = `
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: #800;
    color: white;
    padding: 5px 10px;
    font-family: monospace;
    font-size: 12px;
    display: none;
    z-index: 10;
  `;
  editorContainer.appendChild(errorOverlay);


  jsonEditor.onDidChangeModelContent(() => {
    // Simple debounce to avoid firing on every single keypress
    clearTimeout(window.jsonUpdateTimeout);
    window.jsonUpdateTimeout = setTimeout(() => {
        // Check if content is different from the last *applied* content
        try {
            const currentEditorValue = JSON.parse(jsonEditor.getValue());
            if (JSON.stringify(currentEditorValue) !== JSON.stringify(activeJson)) {
                updateExternalObject();
            }
        } catch (e) {
            // Error will be handled by updateExternalObject if user stops typing
            updateExternalObject();
        }
    }, 300);
  });
});