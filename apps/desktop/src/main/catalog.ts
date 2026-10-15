// Main-only catalog Module. Renderer access must use future owner-validated commands.
export { CatalogModule } from "@ssterm/services";
export {
  resolveHostConfig,
  queryCatalogHosts,
  catalogGroupTree,
} from "@ssterm/domain";
