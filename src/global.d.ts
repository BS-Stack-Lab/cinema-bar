import type { CinemaApi } from '../electron/types';
declare global {
  interface Window {
    cinema: CinemaApi;
  }
}
