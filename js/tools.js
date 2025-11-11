let currentMode = 'translate';

const toolsElm = document.getElementById('tools');
let offsetX, offsetY;
let isDragging = false;

function setTransformMode(mode) {
    currentMode = mode;
    if (transformControls) {
        transformControls.setMode(mode);
    }
    document.querySelectorAll('.tools button').forEach(btn =>
        btn.classList.remove('active'));
    const btn = document.getElementById(`${mode}Btn`);
    if (btn) {
        btn.classList.add('active');
    }
}

// Make sure this function is globally available if it isn't already
if (!window.deselectObject) {
    window.deselectObject = function() {
        if (typeof ungroupAndDeselect === 'function') {
            ungroupAndDeselect();
        } else {
            console.warn('ungroupAndDeselect function not found.');
        }
    };
}

toolsElm.addEventListener('mousedown', (e) => {
    // Prevent dragging if clicking a button
    if (e.target.closest('button')) return;
    
    isDragging = true;
    offsetX = e.clientX - toolsElm.offsetLeft;
    offsetY = e.clientY - toolsElm.offsetTop;
    toolsElm.style.cursor = 'grabbing';
});

document.addEventListener('mouseup', () => {
    isDragging = false;
    toolsElm.style.cursor = 'grab';
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    const x = e.clientX - offsetX;
    const y = e.clientY - offsetY;
    toolsElm.style.left = `${x}px`;
    toolsElm.style.top = `${y}px`;
});

// --- NEW: Keybinds ---
document.addEventListener('keydown', (event) => {
    // Don't trigger if typing in an input field (like search or JSON editor)
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA' || event.target.isContentEditable) {
        return;
    }

    switch (event.key) {
        case '1':
            setTransformMode('translate');
            break;
        case '2':
            setTransformMode('rotate');
            break;
        case '3':
            setTransformMode('scale');
            break;
        case '4':
            window.deselectObject();
            break;
        // --- MODIFICATION: STOP 'Delete' key from triggering deselect ---
        case 'Delete':
        case 'Backspace':
            event.stopPropagation();
            break;
        // --- END MODIFICATION ---
        case '5': 
            if (typeof window.toggleAttachmentMode === 'function') {
                window.toggleAttachmentMode();
            }
            break;
    }
});