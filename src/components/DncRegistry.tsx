import { dncRegistryImport, dncRegistryStatus, pickRegistryFile, type RegistryStatus } from "../lib/service";
import { formatNumber } from "../lib/marks";
import { RegistryFileImport, type RegistrySource } from "./RegistryFileImport";

const source: RegistrySource<RegistryStatus, Awaited<ReturnType<typeof dncRegistryImport>>> = {
  read: dncRegistryStatus, load: dncRegistryImport, pick: pickRegistryFile,
  describe: result => `Loaded ${formatNumber(result.numbers)} numbers for ${result.area_codes.join(", ")}.`,
  ready: state => Boolean(state?.area_codes.length && !state.area_codes.some(code => code.out_of_date)),
  button: state => state?.area_codes.length ? "Load a newer file" : "Load a file",
  pathLabel: "Path to the downloaded registry file",
  progress: lines => `Reading… ${formatNumber(lines)} lines`,
};

/** Registry coverage and age stay specific to DNC; importing and file selection are shared with NANPA. */
export function DncRegistry({ onChanged }: { onChanged: () => void }) {
  return <RegistryFileImport source={source} onChanged={onChanged}>{state => {
    const codes = state?.area_codes ?? [];
    const old = codes.filter(code => code.out_of_date);
    const newest = codes.length ? Math.min(...codes.map(code => code.age_days)) : 0;
    return codes.length
      ? <>National Do Not Call Registry: {formatNumber(state!.numbers)} numbers for {codes.map(code => code.area_code).join(", ")}, file {newest === 0 ? "from today" : `${newest} ${newest === 1 ? "day" : "days"} old`}. Other area codes are not checked.
          {old.length > 0 && <> <strong>{old.map(code => code.area_code).join(", ")} {old.length === 1 ? "is" : "are"} older than {state!.max_age_days} days: download a fresh file.</strong></>}</>
      : <>National Do Not Call Registry not loaded. Your first five area codes are free at telemarketing.donotcall.gov: register, download them, and load the file here.</>;
  }}</RegistryFileImport>;
}
