export interface Pin {
  parcelId: string;
  lat: number;
  lon: number;
  label: string;
}

let mem: Pin[] = [];

/** Agent "show on map" pins: kept in memory, mirrored to sessionStorage when available. */
export const agentPins = {
  get(): Pin[] {
    if (mem.length) return mem;
    try {
      mem = JSON.parse(sessionStorage.getItem("oracle.agentPins") ?? "[]");
    } catch {
      mem = [];
    }
    return mem;
  },
  set(p: Pin[]) {
    mem = p;
    try {
      sessionStorage.setItem("oracle.agentPins", JSON.stringify(p));
    } catch {
      /* storage unavailable: memory only */
    }
  },
};
