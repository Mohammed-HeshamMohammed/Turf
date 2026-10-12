import { nanpaBlocksImport, nanpaBlocksStatus, pickNanpaFile, type BlocksStatus } from "../lib/service";
import { formatNumber } from "../lib/marks";
import { RegistryFileImport, type RegistrySource } from "./RegistryFileImport";

const source: RegistrySource<BlocksStatus, Awaited<ReturnType<typeof nanpaBlocksImport>>> = {
  read: nanpaBlocksStatus, load: path => nanpaBlocksImport(path), pick: pickNanpaFile,
  describe: result => `Loaded ${formatNumber(result.assigned)} utilized blocks and ${formatNumber(result.free)} available blocks in ${result.area_codes} area codes.`,
  ready: state => Boolean(state?.area_codes && (state.oldest_days ?? 0) <= 90),
  button: state => state?.area_codes ? "Load newer NANPA file" : "Load NANPA file",
  pathLabel: "Path to the downloaded NANPA file", showStatusError: true,
};

/** Number-block coverage stays specific to NANPA; importing and file selection are shared with DNC. */
export function NanpaBlocks({ onChanged }: { onChanged: () => void }) {
  return <RegistryFileImport source={source} onChanged={onChanged}>{state => state?.area_codes
    ? <>NANPA number blocks: {formatNumber(state.assigned)} utilized blocks in {state.area_codes} area codes, file {state.oldest_days ?? 0} days old. Available blocks and blocks missing from a utilized-code file are marked suspicious. Other area codes are not checked.{(state.oldest_days ?? 0) > 90 && <strong> Download a fresh file: blocks keep being assigned.</strong>}</>
    : <>NANPA number blocks not loaded. Download the tab-delimited utilized codes for your region from <a href="https://nanpa.com/reports/co-code-reports/cocodes_assign" target="_blank" rel="noreferrer">NANPA's Central Office Code Assignment Records</a>, then load the ZIP or extracted text file here.</>
  }</RegistryFileImport>;
}
