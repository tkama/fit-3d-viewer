import FitParser from 'https://esm.sh/fit-file-parser';

export async function parseFitFile(arrayBuffer) {
  return new Promise((resolve, reject) => {
    try {
      const fitParser = new FitParser({
        force: true,
        speedUnit: 'km/h',
        lengthUnit: 'km',
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

  validRecords.forEach(r => {
    const lat = r.position_lat;
    const lon = r.position_long;
    // some libraries leave it as semicircles
    if (Math.abs(lat) > 180) r.position_lat = lat * (180 / Math.pow(2, 31));
    if (Math.abs(lon) > 180) r.position_long = lon * (180 / Math.pow(2, 31));

    // Calculate mins and maxs
    ['altitude', 'power', 'cadence', 'heart_rate', 'speed'].forEach(key => {
       const v = getValueSafe(r, key);
       if (v < metrics[key].min) metrics[key].min = v;
       if (v > metrics[key].max) metrics[key].max = v;
    });
  });

  return { records: validRecords, metrics };
}
