// EdlAE.aex - After Effects AEGP that puts EDL / XML / FCPXML / OTIO import and
// export into the File > Import, File > Export and Window menus.
//
// The work is done by the bundled ExtendScript (dist/EDL_AE.jsx), compiled
// into this plugin as kEdlAeScript and run with AEGP_ExecuteScript. The script
// opens the EDL AE palette on the requested tab.

#include "AEConfig.h"
#ifdef AE_OS_WIN
#include <windows.h>
#endif

#include "entry.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "AEGP_SuiteHandler.h"

#include <string>

#include "edl_ae_script.h"

extern "C" DllExport AEGP_PluginInitFuncPrototype EntryPointFunc;

namespace {

AEGP_PluginID g_plugin_id = 0;
SPBasicSuite* g_basic = nullptr;
AEGP_Command g_cmd_import = 0;
AEGP_Command g_cmd_export = 0;
AEGP_Command g_cmd_window = 0;

void FreeHandle(AEGP_SuiteHandler& suites, AEGP_MemHandle handle, std::string* text) {
    if (!handle) {
        return;
    }
    if (text) {
        void* data = nullptr;
        if (suites.MemorySuite1()->AEGP_LockMemHandle(handle, &data) == A_Err_NONE && data) {
            *text = static_cast<const char*>(data);
            suites.MemorySuite1()->AEGP_UnlockMemHandle(handle);
        }
    }
    suites.MemorySuite1()->AEGP_FreeMemHandle(handle);
}

A_Err RunScript(const char* tab) {
    AEGP_SuiteHandler suites(g_basic);
    std::string script;
    script.reserve(sizeof(kEdlAeScript) + 64);
    script += "$.global.__EDLAE_LAUNCH = \"";
    script += tab;
    script += "\";\n";
    script += kEdlAeScript;

    AEGP_MemHandle result = nullptr;
    AEGP_MemHandle error = nullptr;
    A_Err err = suites.UtilitySuite6()->AEGP_ExecuteScript(g_plugin_id, script.c_str(), FALSE, &result, &error);

    std::string message;
    FreeHandle(suites, result, nullptr);
    FreeHandle(suites, error, &message);
    if (!message.empty()) {
        std::string info = "Script error: " + message;
        suites.UtilitySuite3()->AEGP_ReportInfo(g_plugin_id, info.c_str());
    }
    return err;
}

A_Err CommandHook(AEGP_GlobalRefcon, AEGP_CommandRefcon, AEGP_Command command, AEGP_HookPriority,
                  A_Boolean, A_Boolean* handledPB) {
    A_Err err = A_Err_NONE;
    if (command == g_cmd_import) {
        err = RunScript("import");
        *handledPB = TRUE;
    } else if (command == g_cmd_export || command == g_cmd_window) {
        err = RunScript("export");
        *handledPB = TRUE;
    }
    return err;
}

A_Err UpdateMenuHook(AEGP_GlobalRefcon, AEGP_UpdateMenuRefcon, AEGP_WindowType) {
    AEGP_SuiteHandler suites(g_basic);
    A_Err err = A_Err_NONE;
    ERR(suites.CommandSuite1()->AEGP_EnableCommand(g_cmd_import));
    ERR(suites.CommandSuite1()->AEGP_EnableCommand(g_cmd_export));
    ERR(suites.CommandSuite1()->AEGP_EnableCommand(g_cmd_window));
    return err;
}

}  // namespace

A_Err EntryPointFunc(struct SPBasicSuite* pica_basicP, A_long, A_long, AEGP_PluginID aegp_plugin_id,
                     AEGP_GlobalRefcon*) {
    g_plugin_id = aegp_plugin_id;
    g_basic = pica_basicP;
    A_Err err = A_Err_NONE;
    A_Err err2 = A_Err_NONE;
    AEGP_SuiteHandler suites(pica_basicP);

    ERR(suites.CommandSuite1()->AEGP_GetUniqueCommand(&g_cmd_import));
    ERR(suites.CommandSuite1()->AEGP_GetUniqueCommand(&g_cmd_export));
    ERR(suites.CommandSuite1()->AEGP_GetUniqueCommand(&g_cmd_window));

    ERR(suites.CommandSuite1()->AEGP_InsertMenuCommand(g_cmd_import, "EDL / XML / OTIO...", AEGP_Menu_IMPORT,
                                                       AEGP_MENU_INSERT_SORTED));
    ERR(suites.CommandSuite1()->AEGP_InsertMenuCommand(g_cmd_export, "EDL / XML / OTIO...", AEGP_Menu_EXPORT,
                                                       AEGP_MENU_INSERT_SORTED));
    ERR(suites.CommandSuite1()->AEGP_InsertMenuCommand(g_cmd_window, "EDL AE", AEGP_Menu_WINDOW,
                                                       AEGP_MENU_INSERT_SORTED));

    ERR(suites.RegisterSuite5()->AEGP_RegisterCommandHook(g_plugin_id, AEGP_HP_BeforeAE, AEGP_Command_ALL, CommandHook,
                                                          nullptr));
    ERR(suites.RegisterSuite5()->AEGP_RegisterUpdateMenuHook(g_plugin_id, UpdateMenuHook, nullptr));

    if (err) {
        ERR2(suites.UtilitySuite3()->AEGP_ReportInfo(g_plugin_id, "EDL AE: could not register menu commands."));
    }
    return err;
}
