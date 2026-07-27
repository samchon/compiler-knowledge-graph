-- Run export.lua against the smallest faithful model of LuaLS's injected doc
-- environment. The test executes the real exporter and supplies URI rows which
-- LuaLS's doc-mode enumeration normally filters before a configured external
-- library reaches the script.

local exporterPath = assert(arg[1], 'expected the exporter path')
local report

export = {
    serializeAndExport = function() end,
}
ws = {
    rootUri = '/work/project',
}
vm = {
    getRefs = function() return {} end,
}
guide = {
    eachSource = function() end,
    getUri = function() return nil end,
    rowColOf = function() return 0, 0 end,
}
jsonb = {
    beautify = function(value) return value end,
}
util = {
    saveFile = function(_, value)
        report = value
        return true
    end,
}

local nativeRequire = require
function require(name)
    if name == 'files' then
        return {
            getAllUris = function()
                return {
                    '/work/project/main.lua',
                    '/work/project\\outside.lua',
                    '/work/project-copy/outside.lua',
                }
            end,
            getState = function()
                return { ast = {} }
            end,
        }
    end
    if name == 'file-uri' then
        return {
            decode = function(uri) return uri end,
        }
    end
    return nativeRequire(name)
end

assert(loadfile(exporterPath))()
export.serializeAndExport({}, '/unused')

assert(type(report) == 'table', 'the exporter wrote no report')
assert(#report.files == 1, 'an outside sibling entered the exported file set')
assert(report.files[1] == 'main.lua', 'the in-root file changed identity')
assert(
    report.skipped.outsideRoot == 2,
    'the exporter did not reject both outside sibling spellings'
)
