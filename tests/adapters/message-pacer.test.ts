import { describe, it, expect } from 'vitest';
import { splitIntoBubbles, computeTypingDelayMs } from '../../src/adapters/whatsapp/message-pacer';

describe('message-pacer', () => {
  describe('splitIntoBubbles', () => {
    it('splits multi-paragraph replies into separate bubbles up to maxBubbles', () => {
      const text = 'Baik, saya paham.\n\nJadwal sudah saya catat.\n\nJangan lupa istirahat.\n\nBesok masih ada agenda pagi.';
      const bubbles = splitIntoBubbles(text, 'id-ID', 3);

      expect(bubbles).toEqual([
        'Baik, saya paham.',
        'Jadwal sudah saya catat.',
        'Jangan lupa istirahat.\n\nBesok masih ada agenda pagi.',
      ]);
    });

    it('splits longer single-paragraph replies using Intl.Segmenter sentence boundaries', () => {
      const text =
        'Saya sudah memeriksa catatan jadwal Anda untuk besok pagi. Semuanya terlihat cukup padat, jadi sebaiknya Anda mulai beristirahat sekarang. Jika ada perubahan nanti, kabari saja.';
      const bubbles = splitIntoBubbles(text, 'id-ID', 3);

      expect(bubbles).toEqual([
        'Saya sudah memeriksa catatan jadwal Anda untuk besok pagi.',
        'Semuanya terlihat cukup padat, jadi sebaiknya Anda mulai beristirahat sekarang.',
        'Jika ada perubahan nanti, kabari saja.',
      ]);
    });

    it('keeps short single-paragraph replies, decimals, lists, and URLs intact', () => {
      expect(splitIntoBubbles('Baik. Saya catat.', 'id-ID')).toEqual(['Baik. Saya catat.']);

      const withDecimal =
        'Kenaikan angkanya sekitar 1.5 kali lipat dari kemarin, dan sejauh ini masih dalam batas wajar untuk dipantau.';
      expect(splitIntoBubbles(withDecimal, 'id-ID')).toEqual([withDecimal]);

      const withList =
        'Daftar agenda hari ini:\n1. Rapat pagi jam sembilan.\n2. Tinjau ulang catatan proyek.\n3. Istirahat sore.';
      expect(splitIntoBubbles(withList, 'id-ID')).toEqual([withList]);

      const withUrl =
        'Silakan periksa tautan resmi berikut untuk informasi terbaru: https://example.com/info. Baru setelah itu kita lanjutkan.';
      expect(splitIntoBubbles(withUrl, 'id-ID')).toEqual([withUrl]);
    });

    it('caps sentence segments at maxBubbles by merging trailing sentences', () => {
      const text =
        'Kalimat pertama cukup panjang untuk memulai obrolan. Kalimat kedua menyusul. Kalimat ketiga juga ada. Kalimat keempat digabung.';
      const bubbles = splitIntoBubbles(text, 'id-ID', 2);

      expect(bubbles).toEqual([
        'Kalimat pertama cukup panjang untuk memulai obrolan.',
        'Kalimat kedua menyusul. Kalimat ketiga juga ada. Kalimat keempat digabung.',
      ]);
    });
  });

  describe('computeTypingDelayMs', () => {
    it('clamps typing delay between 600ms and 1500ms', () => {
      expect(computeTypingDelayMs('Ok.')).toBe(600);
      expect(computeTypingDelayMs('x'.repeat(200))).toBe(1500);

      const mid = computeTypingDelayMs('Baik, saya siapkan sekarang.');
      expect(mid).toBeGreaterThanOrEqual(600);
      expect(mid).toBeLessThanOrEqual(1500);
    });
  });
});
