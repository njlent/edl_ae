# Embed the ExtendScript bundle as a NUL-terminated char array.
#   cmake -DIN=dist/EDL_AE.jsx -DOUT=edl_ae_script.h -P embed.cmake
file(READ "${IN}" hex HEX)
string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," bytes "${hex}")
# break lines every 32 bytes to keep compilers happy
string(REGEX REPLACE "((0x[0-9a-f][0-9a-f],){32})" "\\1\n" bytes "${bytes}")
file(WRITE "${OUT}" "// Generated from ${IN} by plugin/cmake/embed.cmake. Do not edit.\n#pragma once\nstatic const char kEdlAeScript[] = {\n${bytes}0x00};\n")
