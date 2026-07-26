-- Runs inside lua-language-server as a `Lua.docScriptPath` build script.
--
-- Not the exporter. This exists to answer, in one CI round, the questions that
-- would otherwise be guessed at while writing the exporter: what
-- `vm.getExportableGlobals()` hands back, what a global's recorded sets look
-- like, whether `vm.getRefs` accepts one of them, and what it returns. Writing
-- an exporter against assumed shapes is how a campaign burns runs.
--
-- The injected environment is fixed by `script/cli/doc/init.lua`:
--   export, ws, vm, guide, getDesc, getLabel, jsonb, util, markdown
-- and `__index = _G`, so ordinary globals are reachable too.
--
-- It replaces `serializeAndExport` rather than adding a phase, because that is
-- the only hook called once with everything already computed. The original is
-- still invoked afterwards so `--doc` behaves normally.

local original = export.serializeAndExport

---Describe one value without assuming it is a table, a source, or alive.
local function describe(value, depth)
    local kind = type(value)
    if kind ~= 'table' then
        return { luaType = kind, value = tostring(value) }
    end
    local out = { luaType = 'table', fields = {} }
    local shown = 0
    for key, inner in pairs(value) do
        if shown >= 12 then
            out.truncated = true
            break
        end
        local name = tostring(key)
        out.fields[name] = (depth > 0 and type(inner) == 'table')
            and describe(inner, depth - 1)
            or type(inner)
        shown = shown + 1
    end
    -- A `parser.object` carries these; a `vm.global` does not. Reporting both
    -- lets the exporter be written against whichever it actually receives.
    out.hasStart = value.start ~= nil
    out.hasFinish = value.finish ~= nil
    out.sourceType = type(value.type) == 'string' and value.type or nil
    return out
end

function export.serializeAndExport(docs, outputDir)
    local report = {
        probeVersion = 1,
        globals = {},
        errors = {},
    }

    local ok, globals = pcall(function()
        return export.gatherGlobals()
    end)
    report.gatherGlobalsOk = ok
    if not ok then
        report.errors[#report.errors + 1] = tostring(globals)
        globals = {}
    end
    report.globalCount = #globals

    -- A handful is enough to learn the shapes; the whole workspace would make
    -- the artifact unreadable and prove nothing extra.
    for index = 1, math.min(#globals, 5) do
        local global = globals[index]
        local entry = { index = index, global = describe(global, 1) }

        entry.hasGetSets = type(global.getSets) == 'function'
        entry.hasGetAllSets = type(global.getAllSets) == 'function'
        entry.name = type(global.getName) == 'function'
            and select(2, pcall(function() return global:getName() end))
            or nil

        local setsOk, sets = pcall(function()
            return global:getAllSets()
        end)
        entry.getAllSetsOk = setsOk
        if setsOk and type(sets) == 'table' then
            entry.setCount = #sets
            local first = sets[1]
            if first ~= nil then
                entry.firstSet = describe(first, 1)
                entry.firstSetUri = select(2, pcall(function()
                    return guide.getUri(first)
                end))
                -- The question the exporter turns on: does the engine resolve
                -- cross-file references from a recorded set, and in what shape?
                local refsOk, refs = pcall(function()
                    return vm.getRefs(first)
                end)
                entry.getRefsOk = refsOk
                if refsOk and type(refs) == 'table' then
                    entry.refCount = #refs
                    if refs[1] ~= nil then
                        entry.firstRef = describe(refs[1], 1)
                        entry.firstRefUri = select(2, pcall(function()
                            return guide.getUri(refs[1])
                        end))
                    end
                else
                    entry.getRefsError = tostring(refs)
                end
            end
        else
            entry.getAllSetsError = tostring(sets)
        end

        report.globals[#report.globals + 1] = entry
    end

    local path = outputDir .. '/samchon-graph-lua-probe.json'
    local saved, saveErr = util.saveFile(path, jsonb.beautify(report))
    if not saved then
        report.errors[#report.errors + 1] = tostring(saveErr)
    end
    print('[samchon-graph] lua probe written to ' .. path)

    return original(docs, outputDir)
end
