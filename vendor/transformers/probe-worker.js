// Sprawdza, czy aplikacja może uruchamiać wątki (wtedy rozpoznawanie mowy liczy na kilku rdzeniach).
postMessage(typeof SharedArrayBuffer === 'function');
