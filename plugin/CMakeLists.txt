# EdlAE.aex - AEGP menu plugin wrapping the EDL AE ExtendScript.
#
#   cmake -S plugin -B plugin/build
#   cmake --build plugin/build --config Release
#
# AE_SDK_ROOT may point at the SDK folder (contains Examples/Headers) or the
# extracted package directory above it. Default: E:/projects/ae/SDK/...

cmake_minimum_required(VERSION 3.20)
project(EdlAE LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(AE_SDK_ROOT "" CACHE PATH "After Effects SDK folder or its containing extracted package directory")
set(EDLAE_SDK_CANONICAL "E:/projects/ae/SDK/AfterEffectsSDK_25.6_61_win")
set(EDLAE_SDK_SENTINEL "Examples/Headers/AEConfig.h")

set(_candidates)
foreach(_root IN ITEMS "${AE_SDK_ROOT}" "${EDLAE_SDK_CANONICAL}")
    if(_root)
        list(APPEND _candidates "${_root}")
        file(GLOB _nested LIST_DIRECTORIES true "${_root}/*.AfterEffectsSDK")
        list(APPEND _candidates ${_nested})
    endif()
endforeach()
set(AE_SDK "")
foreach(_c IN LISTS _candidates)
    if(NOT AE_SDK AND EXISTS "${_c}/${EDLAE_SDK_SENTINEL}")
        set(AE_SDK "${_c}")
    endif()
endforeach()
if(NOT AE_SDK)
    message(FATAL_ERROR "After Effects SDK not found. Pass -DAE_SDK_ROOT=<path to the SDK>.")
endif()
message(STATUS "After Effects SDK: ${AE_SDK}")

if(NOT WIN32)
    message(FATAL_ERROR "This CMake project builds the Windows .aex. On macOS build with Xcode from the SDK templates.")
endif()

set(REPO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/..")
set(EDLAE_BUNDLE "${REPO_ROOT}/dist/EDL_AE.jsx")

# Rebuild the ExtendScript bundle when Node is available, otherwise use dist/ as is.
find_program(NODE_EXECUTABLE node)
file(GLOB EDLAE_JSX_SOURCES CONFIGURE_DEPENDS "${REPO_ROOT}/src/core/*.jsx" "${REPO_ROOT}/src/ae/*.jsx")
if(NODE_EXECUTABLE)
    add_custom_command(
        OUTPUT "${EDLAE_BUNDLE}"
        COMMAND "${NODE_EXECUTABLE}" scripts/build.mjs
        WORKING_DIRECTORY "${REPO_ROOT}"
        DEPENDS ${EDLAE_JSX_SOURCES} "${REPO_ROOT}/scripts/build.mjs" "${REPO_ROOT}/package.json"
        COMMENT "Bundling EDL_AE.jsx"
        VERBATIM)
elseif(NOT EXISTS "${EDLAE_BUNDLE}")
    message(FATAL_ERROR "Node.js not found and ${EDLAE_BUNDLE} missing. Run 'node scripts/build.mjs' first.")
endif()

set(EDLAE_SCRIPT_H "${CMAKE_CURRENT_BINARY_DIR}/generated/edl_ae_script.h")
add_custom_command(
    OUTPUT "${EDLAE_SCRIPT_H}"
    COMMAND "${CMAKE_COMMAND}" -DIN=${EDLAE_BUNDLE} -DOUT=${EDLAE_SCRIPT_H} -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake"
    DEPENDS "${EDLAE_BUNDLE}" "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed.cmake"
    COMMENT "Embedding EDL_AE.jsx"
    VERBATIM)

# PiPL: preprocess the .r, run PiPLtool, preprocess again into an .rc
set(PIPL_TOOL "${AE_SDK}/Examples/Resources/PiPLtool.exe")
set(PIPL_R "${CMAKE_CURRENT_SOURCE_DIR}/src/EdlAE_PiPL.r")
set(PIPL_RR "${CMAKE_CURRENT_BINARY_DIR}/EdlAE_PiPL.rr")
set(PIPL_RRC "${CMAKE_CURRENT_BINARY_DIR}/EdlAE_PiPL.rrc")
set(PIPL_RC "${CMAKE_CURRENT_BINARY_DIR}/EdlAE_PiPL.rc")
add_custom_command(
    OUTPUT "${PIPL_RC}"
    COMMAND cmd /c cl /nologo /TC /EP /I "${AE_SDK}/Examples/Headers" "${PIPL_R}" > "${PIPL_RR}"
    COMMAND "${PIPL_TOOL}" "${PIPL_RR}" "${PIPL_RRC}"
    COMMAND cmd /c cl /nologo /TC /EP /D MSWindows "${PIPL_RRC}" > "${PIPL_RC}"
    DEPENDS "${PIPL_R}"
    COMMENT "Building PiPL resource"
    VERBATIM)

add_library(EdlAE MODULE
    src/EdlAE.cpp
    "${AE_SDK}/Examples/Util/AEGP_SuiteHandler.cpp"
    "${AE_SDK}/Examples/Util/MissingSuiteError.cpp"
    "${PIPL_RC}"
    "${EDLAE_SCRIPT_H}")

target_include_directories(EdlAE PRIVATE
    "${CMAKE_CURRENT_BINARY_DIR}/generated"
    "${AE_SDK}/Examples/Headers"
    "${AE_SDK}/Examples/Headers/SP"
    "${AE_SDK}/Examples/Util"
    "${AE_SDK}/Examples/Resources")

target_compile_definitions(EdlAE PRIVATE MSWindows WIN32 _WINDOWS _CRT_SECURE_NO_WARNINGS)
if(MSVC)
    target_compile_options(EdlAE PRIVATE /W3 /utf-8 /bigobj)
endif()

set_target_properties(EdlAE PROPERTIES PREFIX "" SUFFIX ".aex" OUTPUT_NAME "EdlAE")
