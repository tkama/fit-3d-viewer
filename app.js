import { parseFitFile, processFitData } from './parser.js';

let deckgl = null;
let currentProcessedData = null;
let currentViewState = {
  longitude: 139.7,
  latitude: 35.7,
  zoom: 11,
  pitch: 45,
  bearing: 0
};

// UI Elements
const loader = document.getElementById('loader');
const metricSelect = document.getElementById('metric-select');
const colorSelect = document.getElementById('color-select');
const scaleInput = document.getElementById('height-scale');
const scaleValue = document.getElementById('scale-value');
const speedInput = document.getElementById('speed-input');
const speedValue = document.getElementById('speed-value');
const ftpInput = document.getElementById('ftp-input');
const ftpValue = document.getElementById('ftp-value');
const infoPanel = document.getElementById('info-panel');
const infoStats = document.getElementById('info-stats');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const playBtn = document.getElementById('play-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');
const hudPanel = document.getElementById('hud-panel');
const hudStats = document.getElementById('hud-stats');
const menuToggleBtn = document.getElementById('menu-toggle-btn');
const controlPanel = document.getElementById('control-panel');
const rangeStartInput = document.getElementById('range-start');
const rangeEndInput = document.getElementById('range-end');
const rangeStartVal = document.getElementById('range-start-val');
const rangeEndVal = document.getElementById('range-end-val');
const hudPositionSelect = document.getElementById('hud-position-select');

if (menuToggleBtn && controlPanel) {
  menuToggleBtn.addEventListener('click', () => {
    controlPanel.classList.toggle('open');
  });
}

if (hudPositionSelect) {
  hudPositionSelect.addEventListener('change', (e) => {
    hudPanel.className = 'hud-panel ' + e.target.value;
  });
}

// Caches for DeckGL reactive rendering
let cachedStaticLayers = [];
let lastBearing = null;

// Helper to calculate true visual/physical bearing
function getBearing(p1, p2) {
  const dy = p2.position_lat - p1.position_lat;
  const dx = (p2.position_long - p1.position_long) * Math.cos(p1.position_lat * Math.PI / 180);
  if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) return null;
  return Math.atan2(dx, dy) * 180 / Math.PI;
}

// Metrics configs (useful for color generation)
const getMetricValue = (record, key) => {
  let v = record[key];
  if (v === undefined && key === 'altitude') v = record['enhanced_altitude'];
  if (v === undefined && key === 'speed') v = record['enhanced_speed'];
  return v || 0;
};

function getPowerZoneColor(power, ftp) {
  const percent = (power / ftp) * 100;
  if (percent <= 60) return [128, 128, 128]; // Z1 (Recovery)
  if (percent <= 75) return [0, 112, 192];   // Z2 (Endurance)
  if (percent <= 89) return [0, 176, 80];    // Z3 (Tempo)
  if (percent <= 104) return [255, 192, 0];  // Z4 (Threshold)
  if (percent <= 118) return [237, 125, 49]; // Z5 (VO2Max)
  return [255, 0, 0];                        // Z6 (Anaerobic)
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if(s == 0) {
    r = g = b = l; 
  } else {
    const hue2rgb = (p, q, t) => {
      if(t < 0) t += 1;
      if(t > 1) t -= 1;
      if(t < 1/6) return p + (q - p) * 6 * t;
      if(t < 1/2) return q;
      if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// Generate color based on metric min/max
function getColorForValue(value, min, max) {
  if (min === max) return [59, 130, 246]; // default blue
  
  // Normalize value between 0 and 1
  let norm = (value - min) / (max - min);
  // Clamp
  norm = Math.max(0, Math.min(1, norm));
  
  // We want a gradient. Blue (cold) to Red (hot)
  // Blue is 240, Red is 0. 
  const hue = (1.0 - norm) * 240; 
  return hslToRgb(hue / 360, 1.0, 0.5);
}

function initDeckGL() {
  if (deckgl) return;
  // Make maplibregl available for deck.gl
  window.mapboxgl = window.maplibregl;
  
  deckgl = new deck.DeckGL({
    container: 'map',
    mapStyle: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    initialViewState: currentViewState,
    onViewStateChange: ({viewState}) => {
      currentViewState = viewState;
    },
    controller: {
      doubleClickZoom: true,
      touchZoom: true,
      touchRotate: true,
      dragRotate: true,
      dragPan: true
    },
    layers: []
  });
}

function getMarkerLayer() {
  if (!currentProcessedData || currentFrameProgress < 0) return null;
  const records = currentProcessedData.records;
  if (!records || records.length === 0) return null;
  
  const idx = Math.floor(currentFrameProgress);
  const nextIdx = Math.min(idx + 1, records.length - 1);
  const ratio = currentFrameProgress - idx;
  
  const p1 = records[idx];
  const p2 = records[nextIdx];
  if (!p1 || !p2) return null;

  const lon = p1.position_long + (p2.position_long - p1.position_long) * ratio;
  const lat = p1.position_lat + (p2.position_lat - p1.position_lat) * ratio;

  // Fix marker to surface level (5m offset to avoid z-fighting with map layer)
  const z = 5; 

  // Calculate heading for arrowhead
  const dBearing = getBearing(p1, p2);
  let targetBearing = dBearing !== null ? dBearing : (lastBearing || 0);
  const headingRad = targetBearing * Math.PI / 180;
  
  // Create arrowhead polygon explicitly (Chevron/Arrow tip shape)
  // ダブルサイズに変更
  const size = 0.0006; 
  const back = size * 0.8;
  const width = size * 0.5;
  const inset = size * 0.2; // hollow inset back
  
  // Isotropic scaling correction for Mercator logic
  const cosLat = Math.cos(lat * Math.PI / 180);
  const tipX = (Math.sin(headingRad)*size) / cosLat;
  const tipY = Math.cos(headingRad)*size;
  const blX = (-Math.sin(headingRad)*back - Math.cos(headingRad)*width) / cosLat;
  const blY = -Math.cos(headingRad)*back + Math.sin(headingRad)*width;
  const inX = (-Math.sin(headingRad)*inset) / cosLat;
  const inY = -Math.cos(headingRad)*inset;
  const brX = (-Math.sin(headingRad)*back + Math.cos(headingRad)*width) / cosLat;
  const brY = -Math.cos(headingRad)*back - Math.sin(headingRad)*width;

  const tip = [lon + tipX, lat + tipY, z];
  const bl = [lon + blX, lat + blY, z];
  const innerBack = [lon + inX, lat + inY, z];
  const br = [lon + brX, lat + brY, z];

  return new deck.PolygonLayer({
    id: 'current-marker-layer',
    data: [{ polygon: [tip, bl, innerBack, br] }],
    getPolygon: d => d.polygon,
    getFillColor: [59, 130, 246, 255], // Accent Blue
    extruded: true,
    getElevation: 5, // small physical thickness
    material: false,
    parameters: {
      depthTest: false // ウォールの奥にあっても常に上に描画して透過/隠れるのを防ぐ
    }
  });
}

function updateHUD(idx) {
  if (!currentProcessedData || idx === null || idx < 0) {
    hudPanel.style.display = 'none';
    return;
  }
  hudPanel.style.display = '';

  const hudStatus = document.getElementById('hud-status');
  const hudStatsLive = document.getElementById('hud-stats-live');
  const hudStatsSummary = document.getElementById('hud-stats-summary');
  
  if (!hudStatsLive || !hudStatsSummary) return;

  // Show live view if it is playing, or if hovering/clicking on a specific point mid-route
  // When stopped, currentFrameProgress is 0 -> index is 0, so isLive becomes false.
  const isLive = isPlaying || idx > 0;

  if (isLive) {
    hudStatsLive.style.display = '';
    hudStatsSummary.style.display = 'none';
    if (hudStatus) hudStatus.innerText = 'LIVE';

    const r = currentProcessedData.records[Math.floor(idx)];
    if (!r) return;

    const power = Math.round(getMetricValue(r, 'power'));
    const power3s = Math.round(getMetricValue(r, 'power_3s'));
    const speed = getMetricValue(r, 'speed').toFixed(1);
    const hr = Math.round(getMetricValue(r, 'heart_rate'));
    const alt = Math.round(getMetricValue(r, 'altitude'));
    let cad = Math.round(getMetricValue(r, 'cadence'));
    if (cad === 0) cad = '-';

    // Format Time
    let timeStr = '-';
    let elapsedStr = '-';
    if (r.timestamp) {
      const time = new Date(r.timestamp);
      if (!isNaN(time.valueOf())) {
        timeStr = time.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
        const firstRec = currentProcessedData.records[0];
        if (firstRec && firstRec.timestamp) {
          const firstTime = new Date(firstRec.timestamp);
          if (!isNaN(firstTime.valueOf())) {
            const diffSec = Math.round((time - firstTime) / 1000);
            const hrs = Math.floor(diffSec / 3600);
            const mins = Math.floor((diffSec % 3600) / 60);
            const secs = diffSec % 60;
            elapsedStr = hrs > 0 ? `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}` : `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
          }
        }
      }
    }

    hudStatsLive.innerHTML = `
      <div class="hud-item" style="color: #60a5fa;"><span class="hud-label">Time</span><div><span class="hud-value" style="font-size:1.1rem; font-weight:600;">${timeStr}</span></div></div>
      <div class="hud-item" style="color: #60a5fa; margin-bottom: 8px;"><span class="hud-label">Elapsed</span><div><span class="hud-value" style="font-size:1.1rem; font-weight:600;">${elapsedStr}</span></div></div>
      <div class="hud-item"><span class="hud-label">Power</span><div><span class="hud-value">${power > 0 ? power : '-'}</span><span class="hud-unit">W</span></div></div>
      <div class="hud-item"><span class="hud-label">Pwr(3s)</span><div><span class="hud-value">${power3s > 0 ? power3s : '-'}</span><span class="hud-unit">W</span></div></div>
      <div class="hud-item"><span class="hud-label">Heart</span><div><span class="hud-value">${hr > 0 ? hr : '-'}</span><span class="hud-unit">bpm</span></div></div>
      <div class="hud-item"><span class="hud-label">Speed</span><div><span class="hud-value">${speed > 0 ? speed : '-'}</span><span class="hud-unit">km/h</span></div></div>
      <div class="hud-item"><span class="hud-label">Cadence</span><div><span class="hud-value">${cad}</span><span class="hud-unit">rpm</span></div></div>
      <div class="hud-item"><span class="hud-label">Elev</span><div><span class="hud-value">${alt}</span><span class="hud-unit">m</span></div></div>
    `;
  } else {
    hudStatsLive.style.display = 'none';
    hudStatsSummary.style.display = '';
    if (hudStatus) hudStatus.innerText = 'SUMMARY';

    const sess = currentProcessedData.session;
    if (!sess) return;
    
    const fmtTm = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
      return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    hudStatsSummary.innerHTML = `
      <div class="hud-item"><span class="hud-label">Distance</span><div><span class="hud-value" style="color: var(--accent);">${sess.distance}</span><span class="hud-unit">km</span></div></div>
      <div class="hud-item"><span class="hud-label">Time</span><div><span class="hud-value" style="color: var(--accent);">${fmtTm(sess.elapsedTime)}</span></div></div>
      <div class="hud-item"><span class="hud-label">Ascent</span><div><span class="hud-value">${sess.totalAscent}</span><span class="hud-unit">m</span></div></div>
      <div class="hud-item"><span class="hud-label">Speed</span><div><span class="hud-value" style="font-size:0.9rem;">${sess.avgSpeed.toFixed(1)} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Avg</span></span><br><span class="hud-value" style="font-size:0.9rem;">${sess.maxSpeed.toFixed(1)} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Max</span></span></div></div>
      <div class="hud-item" style="grid-column: span 2;"><span class="hud-label">Power</span><div><span class="hud-value" style="font-size:0.9rem;">${sess.avgPower} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Avg</span></span> &nbsp; <span class="hud-value" style="font-size:0.9rem;">${sess.np} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">NP</span></span> &nbsp; <span class="hud-value" style="font-size:0.9rem;">${sess.maxPower} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Max</span></span></div></div>
      <div class="hud-item"><span class="hud-label">Cadence</span><div><span class="hud-value" style="font-size:0.9rem;">${sess.avgCadence} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Avg</span></span><br><span class="hud-value" style="font-size:0.9rem;">${sess.maxCadence} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Max</span></span></div></div>
      <div class="hud-item"><span class="hud-label">Heart</span><div><span class="hud-value" style="font-size:0.9rem;">${sess.avgHr} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Avg</span></span><br><span class="hud-value" style="font-size:0.9rem;">${sess.maxHr} <span style="font-size:0.7em; color:var(--text-secondary); font-weight:normal;">Max</span></span></div></div>
    `;
  }
}

function handlePathClick(info) {
  if (info && info.index >= 0) {
    let startIndex = 0;
    if (currentProcessedData && currentProcessedData.records) {
      const records = currentProcessedData.records;
      const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
      startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
    }
    currentFrameProgress = info.index + startIndex;
    updateHUD(currentFrameProgress);
    updateMap(true);
  }
}

function handlePathHover(info) {
  if (info && info.index >= 0) {
    let startIndex = 0;
    if (currentProcessedData && currentProcessedData.records) {
      const records = currentProcessedData.records;
      const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
      startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
    }
    const hoverIndex = info.index + startIndex;
    updateHUD(hoverIndex);
  } else {
    updateHUD(currentFrameProgress);
  }
}

function updateMap(isDynamicUpdate = false, resetCamera = true) {
  if (!currentProcessedData || !deckgl) return;
  
  if (!isDynamicUpdate) {
    const zMetric = metricSelect.value;
    const colorMetric = colorSelect.value;
    const scale = parseFloat(scaleInput.value);
    const ftp = parseFloat(ftpInput.value);
    
    const { records, metrics } = currentProcessedData;
    const zMin = metrics[zMetric].min;
    const colorMin = metrics[colorMetric].min;
    const colorMax = metrics[colorMetric].max;
    
    const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
    const rangeEndVal = rangeEndInput ? parseFloat(rangeEndInput.value) : 100;
    
    const startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
    const endIndex = Math.ceil((rangeEndVal / 100) * (records.length - 1));
    
    const pathData = [];
    const polygonData = [];
    
    for (let i = startIndex; i < endIndex && i < records.length - 1; i++) {
      const p1 = records[i];
      const p2 = records[i + 1];
      
      const zVal1 = getMetricValue(p1, zMetric);
      const zVal2 = getMetricValue(p2, zMetric);
      
      let multiplier;
      if (zMetric === 'altitude') multiplier = 1.0;
      else if (zMetric === 'power' || zMetric === 'power_3s') multiplier = 10.0;
      else if (zMetric === 'speed') multiplier = 100.0;
      else multiplier = 20.0;

      const baseVal = zMin === Infinity ? 0 : zMin;
      const z1 = (zVal1 - baseVal) * scale;
      const z2 = (zVal2 - baseVal) * scale;

      const valColor = getMetricValue(p1, colorMetric);
      let pathColor;
      if (colorMetric === 'power' || colorMetric === 'power_3s') {
        pathColor = getPowerZoneColor(valColor, ftp);
      } else {
        pathColor = getColorForValue(valColor, colorMin, colorMax);
      }
      
      const dx = p2.position_long - p1.position_long;
      const dy = p2.position_lat - p1.position_lat;
      const len = Math.sqrt(dx*dx + dy*dy);
      const nx = len === 0 ? 0 : (-dy / len) * 0.00001; 
      const ny = len === 0 ? 0 : (dx / len) * 0.00001;
      
      pathData.push({
        path: [
          [p1.position_long, p1.position_lat, z1 * multiplier],
          [p2.position_long, p2.position_lat, z2 * multiplier]
        ],
        color: pathColor
      });

      polygonData.push({
        polygon: [
          [p1.position_long - nx, p1.position_lat - ny, 0],
          [p2.position_long - nx, p2.position_lat - ny, 0],
          [p2.position_long + nx, p2.position_lat + ny, z2 * multiplier],
          [p1.position_long + nx, p1.position_lat + ny, z1 * multiplier]
        ],
        color: pathColor
      });
    }

    const lineLayer = new deck.PathLayer({
      id: 'route-line-layer',
      data: pathData,
      pickable: true,
      widthScale: 5,
      widthMinPixels: 4,
      getPath: d => d.path,
      getColor: d => d.color,
      getWidth: d => 1,
      onClick: handlePathClick,
      onHover: handlePathHover,
      autoHighlight: true,
      highlightColor: [255, 255, 255]
    });

    const solidPolygonLayer = new deck.SolidPolygonLayer({
      id: 'route-wall-layer',
      data: polygonData,
      getPolygon: d => d.polygon,
      getFillColor: d => [...d.color, 100], 
      extruded: false, 
      wireframe: false,
      pickable: true,
      onClick: handlePathClick,
      onHover: handlePathHover,
      autoHighlight: true,
      highlightColor: [255, 255, 255, 100]
    });

    cachedStaticLayers = [solidPolygonLayer, lineLayer];
  }

  const layersToDraw = [...cachedStaticLayers];
  const markerLayer = getMarkerLayer();
  if (markerLayer) layersToDraw.push(markerLayer);

  if (!isDynamicUpdate) {
    if (resetCamera) {
      const records = currentProcessedData.records;
      
      const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
      const rangeEndVal = rangeEndInput ? parseFloat(rangeEndInput.value) : 100;
      const startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
      const endIndex = Math.ceil((rangeEndVal / 100) * (records.length - 1));
      
      let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
      
      for (let i = startIndex; i <= endIndex && i < records.length; i++) {
        const r = records[i];
        if(r.position_long < minLon) minLon = r.position_long;
        if(r.position_long > maxLon) maxLon = r.position_long;
        if(r.position_lat < minLat) minLat = r.position_lat;
        if(r.position_lat > maxLat) maxLat = r.position_lat;
      }
      
      // If we filtered out all points somehow, use defaults
      if (minLon > maxLon) {
        minLon = 139.7; maxLon = 139.7;
        minLat = 35.7; maxLat = 35.7;
      }

      const centerLon = (minLon + maxLon) / 2;
      const centerLat = (minLat + maxLat) / 2;

      deckgl.setProps({
        layers: layersToDraw,
        initialViewState: {
          longitude: centerLon,
          latitude: centerLat,
          zoom: 12,
          pitch: 60,
          bearing: 0,
          transitionDuration: 1500,
          transitionInterpolator: new deck.FlyToInterpolator()
        }
      });
    } else {
      deckgl.setProps({ layers: layersToDraw });
    }
    
    const records = currentProcessedData.records;
    const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
    const rangeEndVal = rangeEndInput ? parseFloat(rangeEndInput.value) : 100;
    const startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
    const endIndex = Math.ceil((rangeEndVal / 100) * (records.length - 1));

    // Calculate stats dynamic to range
    let hrSum = 0; let hrCount = 0;
    let localMaxPower = -1;
    for (let i = startIndex; i <= endIndex && i < records.length; i++) {
      const r = records[i];
      const hr = r.heart_rate;
      if (hr && hr > 0) { hrSum += hr; hrCount++; }
      const power = getMetricValue(r, 'power');
      if (power > localMaxPower) { localMaxPower = power; }
    }
    
    const avgHR = hrCount > 0 ? Math.round(hrSum / hrCount) : 'N/A';
    const displayMaxPower = localMaxPower > 0 ? Math.round(localMaxPower) : 'N/A';
    const displayAscent = currentProcessedData.session?.totalAscent || 0;

    infoPanel.style.display = 'block';
    
    const totalSelected = endIndex - startIndex + 1;
    const pct = totalSelected === records.length ? '' : ` (${Math.round(totalSelected/records.length*100)}%)`;
    
    infoStats.innerHTML = `
      <strong>Points:</strong> ${totalSelected} / ${records.length}${pct}<br>
      <strong>Max Power:</strong> ${displayMaxPower} W<br>
      <strong>Avg HR:</strong> ${avgHR} bpm<br>
      <strong>Session Ascent:</strong> ${displayAscent} m<br>
    `;
  } else {
    deckgl.setProps({ layers: layersToDraw });
  }
}


async function handleFileUpload(file) {
  loader.style.display = 'flex';
  try {
    const arrayBuffer = await file.arrayBuffer();
    const rawData = await parseFitFile(arrayBuffer);
    currentProcessedData = processFitData(rawData);
    
    if (rangeStartInput && rangeEndInput) {
      rangeStartInput.value = 0;
      rangeStartVal.innerText = '0.0%';
      rangeEndInput.value = 100;
      rangeEndVal.innerText = '100.0%';
    }
    
    currentFrameProgress = 0; // Reset
    updateHUD(currentFrameProgress);
    updateMap(false, true);

    if (controlPanel) {
      controlPanel.classList.remove('open');
    }
  } catch (err) {
    alert("エラーが発生しました: " + err.message);
  } finally {
    loader.style.display = 'none';
  }
}

// Events Setup
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', e => { e.preventDefault(); dropZone.classList.remove('dragover'); });
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    handleFileUpload(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', e => {
  if (e.target.files && e.target.files.length > 0) {
    handleFileUpload(e.target.files[0]);
  }
});

metricSelect.addEventListener('change', e => {
  colorSelect.value = e.target.value; // Sync the color metric when height metric changes
  updateMap(false, false);
});
colorSelect.addEventListener('change', () => updateMap(false, false));
scaleInput.addEventListener('input', e => {
  scaleValue.innerText = e.target.value;
  updateMap(false, false);
});
speedInput.addEventListener('input', e => {
  speedValue.innerText = e.target.value;
});
ftpInput.addEventListener('input', e => {
  ftpValue.innerText = e.target.value;
  localStorage.setItem('fit_ftp_value', e.target.value);
  updateMap(false, false);
});

if (rangeStartInput && rangeEndInput) {
  rangeStartInput.addEventListener('input', e => {
    let startVal = parseFloat(e.target.value);
    let endVal = parseFloat(rangeEndInput.value);
    if (startVal > endVal) {
      startVal = endVal;
      rangeStartInput.value = startVal;
    }
    rangeStartVal.innerText = startVal.toFixed(1) + '%';
    updateMap(false, false);
  });

  rangeEndInput.addEventListener('input', e => {
    let endVal = parseFloat(e.target.value);
    let startVal = parseFloat(rangeStartInput.value);
    if (endVal < startVal) {
      endVal = startVal;
      rangeEndInput.value = endVal;
    }
    rangeEndVal.innerText = endVal.toFixed(1) + '%';
    updateMap(false, false);
  });
}

// Playback Logic
let animationFrameId = null;
let isPlaying = false;
let currentFrameProgress = 0;

function normalizeBearing(prev, curr) {
  if (prev === null) return curr;
  let diff = curr - prev;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  // Blend current bearing slightly for smoothness
  return prev + diff * 0.1;
}

function playbackLoop() {
  if (!isPlaying || !currentProcessedData) return;
  const records = currentProcessedData.records;
  if (!records || records.length === 0) return;
  
  const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
  const rangeEndVal = rangeEndInput ? parseFloat(rangeEndInput.value) : 100;
  const startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
  const endIndex = Math.ceil((rangeEndVal / 100) * (records.length - 1));
  
  const speed = parseFloat(speedInput.value);
  currentFrameProgress += (speed / 60);

  if (currentFrameProgress < startIndex || currentFrameProgress >= endIndex) {
    currentFrameProgress = startIndex; // Loop around within range
  }

  const idx = Math.floor(currentFrameProgress);
  const nextIdx = Math.min(idx + 1, records.length - 1);
  const ratio = currentFrameProgress - idx;
  
  const p1 = records[idx];
  const p2 = records[nextIdx];

  const lon = p1.position_long + (p2.position_long - p1.position_long) * ratio;
  const lat = p1.position_lat + (p2.position_lat - p1.position_lat) * ratio;

  const dBearing = getBearing(p1, p2);
  let targetBearing = dBearing !== null ? dBearing : (lastBearing || 0);
  
  const currentBearing = normalizeBearing(lastBearing, targetBearing);
  lastBearing = currentBearing;

  // Add marker dynamically without forcing full path recreation
  updateHUD(currentFrameProgress);
  updateMap(true); // isDynamicUpdate = true

  // Render camera
  deckgl.setProps({
    initialViewState: {
      longitude: lon,
      latitude: lat,
      zoom: currentViewState.zoom !== undefined ? currentViewState.zoom : 14.5,
      pitch: currentViewState.pitch !== undefined ? currentViewState.pitch : 60,
      bearing: currentBearing,
      transitionDuration: 0 // Manual smooth transition per frame
    }
  });

  animationFrameId = requestAnimationFrame(playbackLoop);
}

function setPlayState(playing) {
  if (playing === isPlaying) return;
  isPlaying = playing;
  
  const hudPlayIcon = document.getElementById('hud-play-icon');
  const hudPauseIcon = document.getElementById('hud-pause-icon');
  
  if (isPlaying) {
    lastBearing = null;
    const records = currentProcessedData.records;
    const rangeStartVal = rangeStartInput ? parseFloat(rangeStartInput.value) : 0;
    const rangeEndVal = rangeEndInput ? parseFloat(rangeEndInput.value) : 100;
    const startIndex = Math.floor((rangeStartVal / 100) * (records.length - 1));
    const endIndex = Math.ceil((rangeEndVal / 100) * (records.length - 1));
    
    if (currentFrameProgress < startIndex || currentFrameProgress >= endIndex) {
      currentFrameProgress = startIndex;
    }
    
    playbackLoop();
    if (hudPlayIcon) hudPlayIcon.style.display = 'none';
    if (hudPauseIcon) hudPauseIcon.style.display = 'block';
  } else {
    cancelAnimationFrame(animationFrameId);
    if (hudPlayIcon) hudPlayIcon.style.display = 'block';
    if (hudPauseIcon) hudPauseIcon.style.display = 'none';
  }
}

playBtn.addEventListener('click', () => {
  if (currentProcessedData) setPlayState(true);
});

pauseBtn.addEventListener('click', () => setPlayState(false));

const hudPlayToggleBtn = document.getElementById('hud-play-toggle-btn');
if (hudPlayToggleBtn) {
  hudPlayToggleBtn.addEventListener('click', () => {
    if (currentProcessedData) {
      setPlayState(!isPlaying);
    }
  });
}

stopBtn.addEventListener('click', () => {
  if (isPlaying || currentFrameProgress > 0) {
    setPlayState(false);
    currentFrameProgress = 0; // reset to beginning
    updateHUD(0); // Update HUD to start
    updateMap(true); // Redraw
    
    // On stop, smoothly pull back the camera
    const records = currentProcessedData.records;
    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    records.forEach(r => {
      if(r.position_long < minLon) minLon = r.position_long;
      if(r.position_long > maxLon) maxLon = r.position_long;
      if(r.position_lat < minLat) minLat = r.position_lat;
      if(r.position_lat > maxLat) maxLat = r.position_lat;
    });
    deckgl.setProps({
      initialViewState: {
        longitude: (minLon + maxLon) / 2,
        latitude: (minLat + maxLat) / 2,
        zoom: currentViewState.zoom || 12,
        pitch: currentViewState.pitch || 60,
        bearing: 0,
        transitionDuration: 1500,
        transitionInterpolator: new deck.FlyToInterpolator()
      }
    });
  }
});

// Initialization
const savedFTP = localStorage.getItem('fit_ftp_value');
if (savedFTP && ftpInput) {
  ftpInput.value = savedFTP;
  if (ftpValue) ftpValue.innerText = savedFTP;
}

initDeckGL();
