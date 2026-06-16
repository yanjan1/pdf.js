import Tesseract from "tesseract.js";

const HIGH_RES_SCALE = 4; // render PDF at 4x for OCR — change to 3 if too slow

class OcrManager {
  constructor(mainContainer, pdfViewer) {
    this.mainContainer = mainContainer;
    this.pdfViewer = pdfViewer;
    this.overlay = null;
    this.selectionCanvas = null;
    this.ctx = null;
    this.isActive = false;
    this.isSelecting = false;
    this.startX = 0;
    this.startY = 0;
    this.endX = 0;
    this.endY = 0;
    this._overlayRect = null;
    this._wasActiveBeforePopup = false;

    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  toggle() {
    if (this.isActive) {
      this.deactivate();
    } else {
      this.activate();
    }
  }

  activate() {
    if (this.isActive) return;
    this.isActive = true;
    document.getElementById("OCRSelectButton").classList.add("toggled");
    this._createOverlay();
    window.addEventListener("keydown", this._onKeyDown);
  }

  deactivate() {
    if (!this.isActive) return;
    this.isActive = false;
    document.getElementById("OCRSelectButton").classList.remove("toggled");
    this._removeOverlay();
    window.removeEventListener("keydown", this._onKeyDown);
  }

  _createOverlay() {
    const rect = this.mainContainer.getBoundingClientRect();
    this._overlayRect = rect;

    this.overlay = document.createElement("div");
    this.overlay.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      z-index: 1000;
      cursor: crosshair;
    `;

    this.selectionCanvas = document.createElement("canvas");
    this.selectionCanvas.width = rect.width;
    this.selectionCanvas.height = rect.height;
    this.selectionCanvas.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    `;
    this.ctx = this.selectionCanvas.getContext("2d");

    this.overlay.appendChild(this.selectionCanvas);
    document.body.appendChild(this.overlay);
    this.overlay.addEventListener("mousedown", this._onMouseDown);
  }

  _removeOverlay() {
    if (this.overlay) {
      this.overlay.removeEventListener("mousedown", this._onMouseDown);
      this.overlay.removeEventListener("mousemove", this._onMouseMove);
      this.overlay.removeEventListener("mouseup", this._onMouseUp);
      document.body.removeChild(this.overlay);
      this.overlay = null;
      this.selectionCanvas = null;
      this.ctx = null;
      this._overlayRect = null;
    }
    this.isSelecting = false;
  }

  _pauseOverlay() {
    if (this.overlay) {
      this.overlay.removeEventListener("mousedown", this._onMouseDown);
      this.overlay.removeEventListener("mousemove", this._onMouseMove);
      this.overlay.removeEventListener("mouseup", this._onMouseUp);
      document.body.removeChild(this.overlay);
      this.overlay = null;
      this.selectionCanvas = null;
      this.ctx = null;
      this._overlayRect = null;
    }
    window.removeEventListener("keydown", this._onKeyDown);
  }

  _resumeOverlay() {
    this._createOverlay();
    window.addEventListener("keydown", this._onKeyDown);
  }

  _onKeyDown(e) {
    if (e.key === "Escape") {
      this.deactivate();
    }
  }

  _onMouseDown(e) {
    this.isSelecting = true;
    this.startX = e.offsetX;
    this.startY = e.offsetY;
    this.endX = e.offsetX;
    this.endY = e.offsetY;
    this.overlay.addEventListener("mousemove", this._onMouseMove);
    this.overlay.addEventListener("mouseup", this._onMouseUp);
  }

  _onMouseMove(e) {
    if (!this.isSelecting) return;
    this.endX = e.offsetX;
    this.endY = e.offsetY;
    this._drawRect();
  }

  _onMouseUp(e) {
    if (!this.isSelecting) return;
    this.endX = e.offsetX;
    this.endY = e.offsetY;
    this.isSelecting = false;
    this.overlay.removeEventListener("mousemove", this._onMouseMove);
    this.overlay.removeEventListener("mouseup", this._onMouseUp);

    const w = this.endX - this.startX;
    const h = this.endY - this.startY;
    if (Math.abs(w) < 5 || Math.abs(h) < 5) {
      this.ctx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
      return;
    }

    this._captureAndOcr();
  }

  _drawRect() {
    this.ctx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
    const w = this.endX - this.startX;
    const h = this.endY - this.startY;
    this.ctx.strokeStyle = "#2196F3";
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash([6, 3]);
    this.ctx.strokeRect(this.startX, this.startY, w, h);
  }

  async _captureAndOcr() {
    const overlayRect = this._overlayRect;

    const selStartXViewport = this.startX + overlayRect.left;
    const selStartYViewport = this.startY + overlayRect.top;
    const selEndXViewport = this.endX + overlayRect.left;
    const selEndYViewport = this.endY + overlayRect.top;

    // find which screen canvas the selection starts on — just to identify the page number
    const allPageCanvases = this.mainContainer.querySelectorAll(".page canvas");
    let screenCanvas = null;
    let pageEl = null;

    for (const canvas of allPageCanvases) {
      const rect = canvas.getBoundingClientRect();
      if (selStartYViewport >= rect.top && selStartYViewport <= rect.bottom) {
        screenCanvas = canvas;
        pageEl = canvas.closest(".page");
        break;
      }
    }

    if (!screenCanvas || !pageEl) {
      this.ctx.clearRect(0, 0, this.selectionCanvas.width, this.selectionCanvas.height);
      this._showPopup(null, "Could not find a page under the selection.");
      return;
    }

    // get page number from the page element's data attribute
    const pageNumber = parseInt(pageEl.dataset.pageNumber, 10);
    if (!pageNumber) {
      this._showPopup(null, "Could not determine page number.");
      return;
    }

    const screenCanvasRect = screenCanvas.getBoundingClientRect();

    // selection as fraction of the screen canvas (0..1)
    const fracX1 = (selStartXViewport - screenCanvasRect.left) / screenCanvasRect.width;
    const fracY1 = (selStartYViewport - screenCanvasRect.top) / screenCanvasRect.height;
    const fracX2 = (selEndXViewport - screenCanvasRect.left) / screenCanvasRect.width;
    const fracY2 = (selEndYViewport - screenCanvasRect.top) / screenCanvasRect.height;

    // pause overlay and show loading
    this._wasActiveBeforePopup = this.isActive;
    if (this.isActive) this._pauseOverlay();
    this._showPopup("Running OCR...", null);

    try {
      // get the actual pdf page object
      const pdfPage = await this.pdfViewer.pdfDocument.getPage(pageNumber);

      // render at HIGH_RES_SCALE
      const viewport = pdfPage.getViewport({ scale: HIGH_RES_SCALE });
      const offscreen = document.createElement("canvas");
      offscreen.width = viewport.width;
      offscreen.height = viewport.height;
      const offscreenCtx = offscreen.getContext("2d");

      await pdfPage.render({
        canvasContext: offscreenCtx,
        viewport,
      }).promise;

      // crop the selection region from the high-res render
      const cropX = Math.max(0, Math.floor(fracX1 * offscreen.width));
      const cropY = Math.max(0, Math.floor(fracY1 * offscreen.height));
      const cropW = Math.min(
        Math.ceil((fracX2 - fracX1) * offscreen.width),
        offscreen.width - cropX
      );
      const cropH = Math.min(
        Math.ceil((fracY2 - fracY1) * offscreen.height),
        offscreen.height - cropY
      );

      if (cropW <= 0 || cropH <= 0) {
        this._showPopup(null, "Selection was outside the page bounds.");
        return;
      }

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = cropW;
      cropCanvas.height = cropH;
      cropCanvas.getContext("2d").drawImage(
        offscreen,
        cropX, cropY, cropW, cropH,
        0, 0, cropW, cropH
      );

      // run tesseract on the high-res crop
      const { data: { text } } = await Tesseract.recognize(cropCanvas, "eng", {
        tessedit_pageseg_mode: "6",
        preserve_interword_spaces: "1",
      });

      const result = text.trim();
      if (!result) {
        this._showPopup(null, "No text found in the selected region.");
      } else {
        this._showPopup(result, null);
      }

    } catch (err) {
      this._showPopup(null, "OCR failed: " + err.message);
    }
  }

  _showPopup(ocrText, errorText) {
    const existing = document.getElementById("ocrPopup");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.id = "ocrPopup";
    popup.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 520px;
      max-height: 600px;
      background: #fff;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.28);
      z-index: 99999;
      display: flex;
      flex-direction: column;
      font-family: sans-serif;
      overflow: hidden;
      cursor: default;
    `;

    popup.innerHTML = `
      <div style="
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #e0e0e0;
        background: #f5f5f5;
        user-select: none;
      ">
        <div style="display:flex; gap: 8px;">
          <button id="ocrTabOcr" style="
            padding: 5px 14px;
            border-radius: 5px;
            border: 1px solid #2196F3;
            background: #2196F3;
            color: #fff;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
          ">OCR Output</button>
          <button id="ocrTabLookup" style="
            padding: 5px 14px;
            border-radius: 5px;
            border: 1px solid #ccc;
            background: #fff;
            color: #333;
            cursor: pointer;
            font-size: 13px;
          ">Word Lookup</button>
        </div>
        <button id="ocrCloseBtn" style="
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #555;
          line-height: 1;
          padding: 0 4px;
        ">✕</button>
      </div>

      <div id="ocrPanelOcr" style="
        flex: 1;
        display: flex;
        flex-direction: column;
        padding: 14px 16px;
        gap: 10px;
        overflow: hidden;
      ">
        ${errorText ? `
          <div style="color:#c0392b;font-size:14px;padding:12px;background:#fdecea;border-radius:6px;">
            ${errorText}
          </div>
        ` : `
          <div style="font-size:12px;color:#888;margin-bottom:2px;">
            OCR may not be 100% accurate. Edit as needed, select a word or phrase, then click Lookup.
          </div>
          <textarea id="ocrTextArea" style="
            flex: 1;
            min-height: 200px;
            max-height: 320px;
            resize: vertical;
            font-size: 14px;
            line-height: 1.6;
            padding: 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-family: inherit;
            outline: none;
            overflow-y: auto;
          ">${ocrText || ""}</textarea>
          <div style="display:flex;justify-content:flex-end;">
            <button id="ocrLookupSelectedBtn" style="
              padding: 7px 18px;
              background: #2196F3;
              color: #fff;
              border: none;
              border-radius: 6px;
              cursor: pointer;
              font-size: 13px;
            ">Lookup Selected Text →</button>
          </div>
        `}
      </div>

      <div id="ocrPanelLookup" style="
        flex: 1;
        display: none;
        flex-direction: column;
        padding: 14px 16px;
        gap: 10px;
        overflow: hidden;
      ">
        <div style="display:flex;gap:8px;">
          <input id="ocrLookupInput" type="text" placeholder="Enter word or phrase..." style="
            flex: 1;
            padding: 8px 10px;
            border: 1px solid #ddd;
            border-radius: 6px;
            font-size: 14px;
            outline: none;
          " />
          <button id="ocrLookupGoBtn" style="
            padding: 8px 16px;
            background: #2196F3;
            color: #fff;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 13px;
          ">Search</button>
        </div>
        <div id="ocrLookupResults" style="
          flex: 1;
          overflow-y: auto;
          max-height: 340px;
          font-size: 14px;
          line-height: 1.6;
          color: #333;
        ">
          <div style="color:#aaa;text-align:center;margin-top:40px;">
            Select text in the OCR tab and click "Lookup Selected Text", or type a word above.
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(popup);

    const tabOcr = popup.querySelector("#ocrTabOcr");
    const tabLookup = popup.querySelector("#ocrTabLookup");
    const panelOcr = popup.querySelector("#ocrPanelOcr");
    const panelLookup = popup.querySelector("#ocrPanelLookup");

    const switchTab = (tab) => {
      if (tab === "ocr") {
        tabOcr.style.cssText += "background:#2196F3;color:#fff;border-color:#2196F3;";
        tabLookup.style.cssText += "background:#fff;color:#333;border-color:#ccc;";
        panelOcr.style.display = "flex";
        panelLookup.style.display = "none";
      } else {
        tabLookup.style.cssText += "background:#2196F3;color:#fff;border-color:#2196F3;";
        tabOcr.style.cssText += "background:#fff;color:#333;border-color:#ccc;";
        panelOcr.style.display = "none";
        panelLookup.style.display = "flex";
      }
    };

    tabOcr.addEventListener("click", () => switchTab("ocr"));
    tabLookup.addEventListener("click", () => switchTab("lookup"));

    popup.querySelector("#ocrCloseBtn").addEventListener("click", () => {
      popup.remove();
      if (this._wasActiveBeforePopup) {
        this._resumeOverlay();
      }
    });

    const lookupSelectedBtn = popup.querySelector("#ocrLookupSelectedBtn");
    if (lookupSelectedBtn) {
      lookupSelectedBtn.addEventListener("click", () => {
        const textarea = popup.querySelector("#ocrTextArea");
        const selected = textarea
          ? textarea.value.substring(textarea.selectionStart, textarea.selectionEnd).trim()
          : "";
        if (!selected) {
          alert("Select some text in the OCR output first.");
          return;
        }
        popup.querySelector("#ocrLookupInput").value = selected;
        switchTab("lookup");
        this._doLookup(selected, popup);
      });
    }

    const lookupGoBtn = popup.querySelector("#ocrLookupGoBtn");
    const lookupInput = popup.querySelector("#ocrLookupInput");
    if (lookupGoBtn && lookupInput) {
      lookupGoBtn.addEventListener("click", () => {
        const word = lookupInput.value.trim();
        if (word) this._doLookup(word, popup);
      });
      lookupInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const word = lookupInput.value.trim();
          if (word) this._doLookup(word, popup);
        }
      });
    }
  }

  async _doLookup(word, popup) {
    const resultsEl = popup.querySelector("#ocrLookupResults");
    resultsEl.innerHTML = `<div style="color:#aaa;text-align:center;margin-top:40px;">Looking up "${word}"...</div>`;

    try {
      const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!res.ok) {
        resultsEl.innerHTML = `<div style="color:#c0392b;padding:12px;background:#fdecea;border-radius:6px;">
          No definition found for "<strong>${word}</strong>".
        </div>`;
        return;
      }
      const data = await res.json();
      resultsEl.innerHTML = this._renderDefinitions(word, data);
      resultsEl.querySelectorAll(".ocrSaveBtn").forEach(btn => {
        btn.addEventListener("click", () => {
          const payload = JSON.parse(btn.dataset.payload);
          this._saveToBackend(payload, btn);
        });
      });
    } catch (err) {
      resultsEl.innerHTML = `<div style="color:#c0392b;padding:12px;background:#fdecea;border-radius:6px;">
        Lookup failed: ${err.message}
      </div>`;
    }
  }

  _renderDefinitions(word, data) {
    let html = `<div style="font-weight:700;font-size:16px;margin-bottom:10px;">${word}</div>`;
    for (const entry of data) {
      for (const meaning of entry.meanings) {
        html += `<div style="margin-bottom:14px;">`;
        html += `<div style="font-style:italic;color:#2196F3;font-size:13px;margin-bottom:4px;">${meaning.partOfSpeech}</div>`;
        meaning.definitions.slice(0, 3).forEach((def, i) => {
          const payload = JSON.stringify({
            word,
            partOfSpeech: meaning.partOfSpeech,
            definition: def.definition,
            example: def.example || null,
          });
          html += `<div style="padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;background:#fafafa;">`;
          html += `<div style="font-size:13px;">${i + 1}. ${def.definition}</div>`;
          if (def.example) {
            html += `<div style="font-size:12px;color:#888;margin-top:3px;font-style:italic;">"${def.example}"</div>`;
          }
          html += `<div style="display:flex;justify-content:flex-end;margin-top:6px;">
            <button class="ocrSaveBtn" data-payload='${payload}' style="
              padding:4px 12px;font-size:12px;background:#27ae60;
              color:#fff;border:none;border-radius:4px;cursor:pointer;
            ">Save</button>
          </div></div>`;
        });
        html += `</div>`;
      }
    }
    return html;
  }

  async _saveToBackend(payload, btn) {
    btn.textContent = "Saving...";
    btn.disabled = true;
    try {
      const res = await fetch("/api/words/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      btn.textContent = "Saved ✓";
      btn.style.background = "#aaa";
    } catch (err) {
      btn.textContent = "Failed";
      btn.style.background = "#c0392b";
      btn.disabled = false;
      console.error("Save failed:", err);
    }
  }
}

export { OcrManager };