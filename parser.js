import FitParser from 'https://esm.sh/fit-file-parser';

export async function parseFitFile(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'm',
        temperatureUnit: 'celcius',
        elapsedRecordField: true,
        mode: 'list',
      });

      fitParser.parse(arrayBuffer, function (error, data) {
        if (error) {
          reject(error);
        } else {
          resolve(data);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function getValueSafe(record, key) {
  let v = record[key];
  if (v === undefined && key === 'altitude') v = record['enhanced_altitude'];
  if (v === undefined && key === 'speed') v = record['enhanced_speed'];
  if (v === undefined && key === 'power') v = record['power']; // fallback if needed

  if (v === undefined || v === null || isNaN(v)) {
     return 0;
  }
  return v;
}

export function processFitData(fitData) {
  if (!fitData || !fitData.records) {
    throw new Error('No records found in FIT file');
  }

  const validRecords = fitData.records.filter(r => 
    r.position_lat !== undefined && 
    r.position_long !== undefined
  );

  if (validRecords.length === 0) {
    throw new Error('No valid GPS coordinates found in FIT file');
  }

  // Find min/max for normalization
  let metrics = {
    altitude: { min: Infinity, max: -Infinity },
    power: { min: Infinity, max: -Infinity },
    cadence: { min: Infinity, max: -Infinity },
    heart_rate: { min: Infinity, max: -Infinity },
    speed: { min: Infinity, max: -Infinity }
  };

  let power3sMetric = { min: Infinity, max: -Infinity };

  for (let i = 0; i < validRecords.length; i++) {
    const r = validRecords[i];
    const lat = r.position_lat;
    const lon = r.position_long;
    // some libraries leave it as semicircles
    if (Math.abs(lat) > 180) r.position_lat = lat * (180 / Math.pow(2, 31));
    if (Math.abs(lon) > 180) r.position_long = lon * (180 / Math.pow(2, 31));

    let pSum = 0;
    let pCount = 0;
    // 3s moving average (current and 2 preceding points)
    for (let j = Math.max(0, i - 2); j <= i; j++) {
       pSum += getValueSafe(validRecords[j], 'power');
       pCount++;
    }
    r.power_3s = pCount > 0 ? (pSum / pCount) : 0;
    
    if (r.power_3s < power3sMetric.min) power3sMetric.min = r.power_3s;
    if (r.power_3s > power3sMetric.max) power3sMetric.max = r.power_3s;

    // Calculate mins and maxs
    ['altitude', 'power', 'cadence', 'heart_rate', 'speed'].forEach(key => {
       const v = getValueSafe(r, key);
       if (v < metrics[key].min) metrics[key].min = v;
       if (v > metrics[key].max) metrics[key].max = v;
    });
  }
  metrics.power_3s = power3sMetric;

  let session = fitData.sessions && fitData.sessions.length > 0 ? fitData.sessions[0] : {};
  let totalAscent = session.total_ascent;
  if (!totalAscent) {
    totalAscent = 0;
    for (let i = 1; i < validRecords.length; i++) {
      const pAlt = getValueSafe(validRecords[i - 1], 'altitude');
      const cAlt = getValueSafe(validRecords[i], 'altitude');
      if (cAlt > pAlt) {
        totalAscent += (cAlt - pAlt);
      }
    }
  }

  // Calculate fallbacks for stats
  let sumPwr = 0, countPwr = 0;
  let sumCad = 0, countCad = 0;
  let sumHr = 0, countHr = 0;
  
  validRecords.forEach(r => {
    let p = getValueSafe(r, 'power');
    if (p > 0) { sumPwr += p; countPwr++; }
    
    let c = getValueSafe(r, 'cadence');
    if (c > 0) { sumCad += c; countCad++; }
    
    let h = getValueSafe(r, 'heart_rate');
    if (h > 0) { sumHr += h; countHr++; }
  });

  // Calculate NP fallback (30s window average ^ 4)
  let npSum = 0, npCount = 0;
  for (let i = 29; i < validRecords.length; i++) {
    let wSum = 0;
    for (let j = i - 29; j <= i; j++) wSum += getValueSafe(validRecords[j], 'power');
    let wAvg = wSum / 30;
    npSum += Math.pow(wAvg, 4);
    npCount++;
  }
  let npFallback = npCount > 0 ? Math.round(Math.pow(npSum / npCount, 0.25)) : 0;

  // Set safe distance fallback
  let distanceKm = 0;
  if (session.total_distance !== undefined) {
    distanceKm = (session.total_distance / 1000).toFixed(1);
  } else if (validRecords.length > 0 && validRecords[validRecords.length-1].distance) {
    distanceKm = (validRecords[validRecords.length-1].distance / 1000).toFixed(1);
  }

  const sessionStats = {
    distance: distanceKm,
    elapsedTime: session.total_elapsed_time || session.total_timer_time || validRecords.length,
    totalAscent: Math.round(totalAscent),
    
    avgSpeed: session.enhanced_avg_speed || session.avg_speed || 0,
    maxSpeed: session.enhanced_max_speed || session.max_speed || metrics.speed.max,
    
    avgPower: session.avg_power || (countPwr > 0 ? Math.round(sumPwr / countPwr) : 0),
    np: session.normalized_power || npFallback,
    maxPower: session.max_power || metrics.power.max,
    
    avgCadence: session.avg_cadence || (countCad > 0 ? Math.round(sumCad / countCad) : 0),
    maxCadence: session.max_cadence || metrics.cadence.max,
    
    avgHr: session.avg_heart_rate || (countHr > 0 ? Math.round(sumHr / countHr) : 0),
    maxHr: session.max_heart_rate || metrics.heart_rate.max
  };

  return { records: validRecords, metrics, session: sessionStats };
}
