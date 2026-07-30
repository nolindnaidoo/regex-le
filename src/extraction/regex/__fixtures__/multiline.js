// Constructor split across lines — per-line extractor misses this entirely
const spanning = new RegExp(
	'\\d{4}-\\d{2}-\\d{2}',
	'g',
);

// Single-line control right next to it, so the snapshot proves the asymmetry
const control = new RegExp('\\d{2}:\\d{2}', 'g');
