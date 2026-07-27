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
local furi = require 'file-uri'

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
        probeVersion = 3,
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

    -- Round two. Round one proved the chain works and that it reaches almost
    -- nothing: `getExportableGlobals` returned a single entry for a project
    -- whose real content is a module-local function, which is how idiomatic Lua
    -- is written. An exporter built on that list would index one symbol and
    -- look successful. So the question becomes whether the workspace itself can
    -- be enumerated and its local declarations reached.
    local filesOk, filesModule = pcall(require, 'files')
    report.filesModuleOk = filesOk
    if filesOk and type(filesModule) == 'table' then
        report.filesApi = {}
        for _, name in ipairs({
            'getAllUris', 'eachFile', 'getState', 'getText', 'getVisibleUris',
        }) do
            report.filesApi[name] = type(filesModule[name])
        end

        local urisOk, uris = pcall(function()
            return filesModule.getAllUris(ws.rootUri)
        end)
        report.getAllUrisOk = urisOk
        if urisOk and type(uris) == 'table' then
            report.uriCount = #uris
            report.uriSample = {}
            report.boundaryFixtureLoaded = false
            for _, uri in ipairs(uris) do
                local absolute = furi.decode(uri)
                if type(absolute) == 'string'
                    and absolute:find('lua-probe-project\\outside', 1, true) then
                    report.boundaryFixtureLoaded = true
                end
            end
            for index = 1, math.min(#uris, 5) do
                report.uriSample[index] = uris[index]
            end

            -- One file walked to its declarations. `guide.eachSource` over a
            -- parsed state is the route a real exporter would take, so the
            -- probe reports which declaration kinds it actually sees and
            -- whether one of them answers `vm.getRefs`.
            local first = uris[1]
            if first ~= nil then
                local stateOk, state = pcall(function()
                    return filesModule.getState(first)
                end)
                report.getStateOk = stateOk
                if stateOk and type(state) == 'table' and state.ast ~= nil then
                    local kinds, locals = {}, 0
                    local sample
                    guide.eachSource(state.ast, function(source)
                        local kind = source.type
                        if type(kind) == 'string' then
                            kinds[kind] = (kinds[kind] or 0) + 1
                            if (kind == 'local' or kind == 'setfield'
                                or kind == 'setmethod' or kind == 'function')
                                and sample == nil then
                                sample = source
                            end
                            if kind == 'local' then locals = locals + 1 end
                        end
                    end)
                    report.declarationKinds = kinds
                    report.localCount = locals

                    -- Round three. The conformance corpus wants an edge from
                    -- the declaration a reference sits inside to the one it
                    -- names, which needs every declaration to carry a span
                    -- covering its body. LuaLS puts the name and the body on
                    -- different nodes: `function caller() ... end` is a
                    -- `setglobal` or `local` holding the name, whose value is
                    -- the `function` node that spans the whole thing. If that
                    -- link is `.value`, the exporter can name a declaration and
                    -- still know where its body ends.
                    report.namedFunctions = {}
                    guide.eachSource(state.ast, function(source)
                        if #report.namedFunctions >= 4 then return end
                        local holder = source.type
                        if holder ~= 'local' and holder ~= 'setglobal'
                            and holder ~= 'setfield'
                            and holder ~= 'setmethod' then
                            return
                        end
                        local entry = {
                            holderType = holder,
                            holderStart = source.start,
                            holderFinish = source.finish,
                            hasValue = source.value ~= nil,
                            valueType = type(source.value) == 'table'
                                and source.value.type or nil,
                            valueStart = type(source.value) == 'table'
                                and source.value.start or nil,
                            valueFinish = type(source.value) == 'table'
                                and source.value.finish or nil,
                        }
                        entry.name = type(source[1]) == 'string'
                            and source[1]
                            or (type(source.field) == 'table'
                                and source.field[1] or nil)
                        -- Positions are packed; the exporter converts through
                        -- rowColOf, so report both forms to be sure they agree.
                        if entry.valueStart ~= nil then
                            local row, col = guide.rowColOf(entry.valueStart)
                            entry.valueStartRowCol = { row = row, col = col }
                        end
                        report.namedFunctions[#report.namedFunctions + 1] = entry
                    end)
                    if sample ~= nil then
                        report.localSample = describe(sample, 1)
                        local refsOk, refs = pcall(function()
                            return vm.getRefs(sample)
                        end)
                        report.localGetRefsOk = refsOk
                        report.localRefCount =
                            (refsOk and type(refs) == 'table') and #refs or nil
                        if not refsOk then
                            report.localGetRefsError = tostring(refs)
                        end
                    end
                else
                    report.getStateError = tostring(state)
                end
            end
        else
            report.getAllUrisError = tostring(uris)
        end
    end

    local path = outputDir .. '/samchon-graph-lua-probe.json'
    local saved, saveErr = util.saveFile(path, jsonb.beautify(report))
    if not saved then
        report.errors[#report.errors + 1] = tostring(saveErr)
    end
    print('[samchon-graph] lua probe written to ' .. path)

    return original(docs, outputDir)
end
