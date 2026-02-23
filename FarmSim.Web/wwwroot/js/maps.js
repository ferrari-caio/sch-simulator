(function () {
  const SCRIPT_ID = "gmaps-script";
  const CALLBACK_NAME = "__gmapsOnLoad";
  const MAP_ID = "b148da6eb6229644eaa05434";

  // Per-map state is stored in a WeakMap so it gets garbage-collected with the DOM element.
  const _mapState = new WeakMap();

  /**
   * Gets (or creates) the internal state object for a given map DOM element.
   * @param {HTMLElement} element
   */
  function getState(element) {
    let state = _mapState.get(element);
    if (!state) {
      state = {
        map: null,
        defaultMinZoom: 3,

        // Field creation
        isCreating: false,
        dotNetRef: null,
        mapClickListener: null,
        draftMarkers: [],
        draftPolyline: null,
        localDraftVertices: [],
        selectedIndex: -1,

        // Final field
        finalPolyline: null,
        finalMinZoom: null,
        // The exact viewport bounds produced by the final fit (used for strict pan restriction).
        finalRestrictionBounds: null,
        zoomListener: null,
        centerListener: null,
        isRecentering: false,
      };
      _mapState.set(element, state);
    }
    return state;
  }

  /**
   * Returns true if the current viewport fully contains the provided bounds.
   * Note: This checks the SW/NE corners, which is sufficient for a LatLngBounds AABB containment test.
   * @param {google.maps.LatLngBounds} viewport
   * @param {google.maps.LatLngBounds} target
   */
  function viewportContainsBounds(viewport, target) {
    if (!viewport || !target) return false;
    const ne = target.getNorthEast();
    const sw = target.getSouthWest();
    return viewport.contains(ne) && viewport.contains(sw);
  }

  /**
   * Waits for the next "idle" event.
   * @param {google.maps.Map} map
   */
  function waitForIdle(map) {
    return new Promise((resolve) => {
      google.maps.event.addListenerOnce(map, "idle", () => resolve());
    });
  }

  /**
   * Clamps a value between min and max.
   */
  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  /**
   * Clamps the map center so it never leaves the restriction bounds.
   * This is a safety net in case the API temporarily allows a center outside the bounds.
   * @param {*} state
   */
  function clampCenterToRestriction(state) {
    if (!state?.map) return;
    const rb = state.finalRestrictionBounds;
    if (!rb) return;

    const c = state.map.getCenter();
    if (!c) return;
    if (rb.contains(c)) return;

    const ne = rb.getNorthEast();
    const sw = rb.getSouthWest();

    const lat = clamp(c.lat(), sw.lat(), ne.lat());
    const lng = clamp(c.lng(), sw.lng(), ne.lng());

    if (state.isRecentering) return;
    state.isRecentering = true;
    state.map.setCenter({ lat, lng });
    window.setTimeout(() => {
      state.isRecentering = false;
    }, 0);
  }

  /**
   * Converts a C# GeoPoint {lat/lng} or {Lat/Lng} into a Google Maps LatLngLiteral.
   * @param {*} p
   * @returns {{lat:number, lng:number} | null}
   */
  function toLatLngLiteral(p) {
    if (!p) return null;
    const lat = p.lat ?? p.Lat;
    const lng = p.lng ?? p.Lng;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return { lat, lng };
  }

  /**
   * Returns the draft line/vertex color based on vertex count.
   * @param {number} count
   */
  function getDraftColor(count) {
    // Green for a valid polygon (3+ vertices), otherwise red.
    return count >= 3 ? "#52ff5b" : "#ff4343";
  }

  /**
   * Creates the marker icon used for vertices.
   * @param {string} strokeColor
   */
  function makeVertexIcon(strokeColor) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 6,
      fillColor: "#ffffff",
      fillOpacity: 1,
      strokeColor,
      strokeOpacity: 1,
      strokeWeight: 4,
    };
  }

  /**
   * Creates the marker icon used for the selected vertex.
   * @param {string} _draftColor The current draft validity color (red/green). Kept for signature symmetry.
   */
  function makeSelectedVertexIcon(_draftColor) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 7,
      fillColor: "#ffffff",
      fillOpacity: 1,
      // Blue outline to provide a clear selection indicator.
      strokeColor: "#309eff",
      strokeOpacity: 1,
      strokeWeight: 5,
    };
  }

  /**
   * Applies the pan/zoom locking rules for the final field state.
   * @param {*} state
   */
  function applyFinalPanLock(state) {
    if (!state?.map) return;
    if (typeof state.finalMinZoom !== "number") return;

    // Keep wheel zoom enabled at all times.
    state.map.setOptions({ scrollwheel: true, gestureHandling: "greedy" });

    // Re-assert minZoom + restriction in case any other code overwrote options.
    if (state.map.get("minZoom") !== state.finalMinZoom) {
      state.map.setOptions({ minZoom: state.finalMinZoom });
    }

    if (state.finalRestrictionBounds) {
      const restriction = state.map.get("restriction");
      if (!restriction || !restriction.latLngBounds) {
        state.map.setOptions({
          restriction: {
            latLngBounds: state.finalRestrictionBounds,
            strictBounds: true,
          },
        });
      }
    }

    const currentZoom = state.map.getZoom();

    // Defensive enforcement in case fractional zoom slips below minZoom.
    if (typeof currentZoom === "number" && currentZoom < state.finalMinZoom) {
      state.map.setZoom(state.finalMinZoom);
    }

    // Ensure the center never leaves the restriction bounds.
    clampCenterToRestriction(state);
  }

  /**
   * Clears the draft markers/polyline from the map.
   * @param {*} state
   */
  function clearDraft(state) {
    if (!state) return;

    if (state.draftPolyline) {
      state.draftPolyline.setMap(null);
      state.draftPolyline = null;
    }

    if (Array.isArray(state.draftMarkers)) {
      state.draftMarkers.forEach((m) => m && m.setMap && m.setMap(null));
      state.draftMarkers = [];
    }

    state.localDraftVertices = [];
    state.selectedIndex = -1;
  }

  /**
   * Redraws (or creates) the draft polyline using state.localDraftVertices.
   * @param {*} state
   */
  function renderDraftPolyline(state) {
    if (!state?.map) return;

    const vertices = Array.isArray(state.localDraftVertices) ? state.localDraftVertices : [];
    const color = getDraftColor(vertices.length);

    const path = vertices.map((v) => ({ lat: v.lat, lng: v.lng }));
    if (vertices.length >= 3) {
      path.push({ lat: vertices[0].lat, lng: vertices[0].lng });
    }

    if (!state.draftPolyline) {
      state.draftPolyline = new google.maps.Polyline({
        map: state.map,
        path,
        clickable: false,
        strokeColor: color,
        strokeOpacity: 1,
        strokeWeight: 2,
      });
    } else {
      state.draftPolyline.setPath(path);
      state.draftPolyline.setOptions({ strokeColor: color });
    }

    // Keep markers in sync with the current validity color.
    if (Array.isArray(state.draftMarkers)) {
      const sel = typeof state.selectedIndex === "number" ? state.selectedIndex : -1;
      state.draftMarkers.forEach((m, idx) => {
        if (!m || !m.setIcon) return;
        m.setIcon(idx === sel ? makeSelectedVertexIcon(color) : makeVertexIcon(color));
        if (typeof m.setZIndex === "function") {
          m.setZIndex(idx === sel ? 999 : undefined);
        }
      });
    }
  }

  window.maps = {
    ensureLoaded: function (apiKey) {
      return new Promise(function (resolve, reject) {
  
        if (window.google && window.google.maps && window.google.maps.Map) {
          resolve();
          return;
        }

        // if script already exists, just wait until it's truly ready
        const existing = document.getElementById(SCRIPT_ID);
        if (existing) {
          // wait for the callback that ensures the Map is available
          const check = () => {
            if (window.google && window.google.maps && window.google.maps.Map) resolve();
            else setTimeout(check, 50);
          };
          check();
          return;
        }

        // global callback that Google calls when it has finished initializing
        window[CALLBACK_NAME] = function () {
          console.info("gmaps callback fired");
          resolve();
        };

        const s = document.createElement("script");
        s.id = SCRIPT_ID;

        // IMPORTANT:
        // - callback=... ensures that it only resolves when the API has finished initializing
        // - v=weekly is the recommended default
        // - loading=async removes the warning
        s.src =
          "https://maps.googleapis.com/maps/api/js?key=" +
          encodeURIComponent(apiKey) +
          "&v=weekly&loading=async&callback=" +
          CALLBACK_NAME+
          "&map_ids=" + encodeURIComponent(MAP_ID); // The Map ID to use, which is configured through the Google Cloud Console.

        s.async = true;
        s.defer = true;

        s.onerror = function (e) {
          console.error("gmaps script failed", e);
          reject(e);
        };

        document.head.appendChild(s);
      });
    },

    initializeMap: function (element, lat, lng, zoom) {
      console.info("maps.initializeMap called", { element, lat, lng, zoom });

      if (!window.google || !window.google.maps || !window.google.maps.Map) {
        console.error("Google Maps API not ready (Map constructor missing)");
        return;
      }

      const map = new google.maps.Map(element, {
        backgroundColor: "#ffffff",                     // Color used for the background of the Map div. This color will be visible when tiles have not yet loaded as the user pans.
        cameraControl: false,                             // The enabled/disabled state of the Camera control.
        center: { lat: lat ?? 0, lng: lng ?? 0 },         // The initial Map center.
        clickableIcons: false,                            // When false, map icons are not clickable. A map icon represents a point of interest, also known as a POI.
        fullscreenControl: false,                         // The enabled/disabled state of the Fullscreen control.
        gestureHandling: "greedy",                        // "cooperative", "greedy", "none", "auto"
        heading: 0,                                       // The initial Map heading (orientation) in degrees measured clockwise from cardinal direction North. Allowed values are from 0 to 360.
        isFractionalZoomEnabled: true,                    // Whether the map should allow fractional zoom levels.
        keyboardShortcuts: false,                         // If false, prevents the map from being controlled by the keyboard.
        mapId: MAP_ID,                                    // The Map ID to use, which is configured through the Google Cloud Console.
        mapTypeControl: false,                            // The initial enabled/disabled state of the Map type control.
        mapTypeId: "hybrid",                              // "hybrid" (transparent layer of major streets on satellite images), "roadmap" (normal street map), "satellite" (satellite images), "terrain" (physical features such as terrain and vegetation).
        maxZoom: 21,                                      // The maximum zoom level which will be displayed on the map.
        minZoom: 3,                                       // The minimum zoom level which will be displayed on the map.
        renderingType: google.maps.RenderingType.RASTER,  // Whether the map should be a RASTER or VECTOR map.
        rotateControl: false,                             // The enabled/disabled state of the Rotate control.
        scaleControl: true,                               // The initial enabled/disabled state of the Scale control.
        streetViewControl: false,                         // The initial enabled/disabled state of the Street View Pegman control. 
        tilt: 0,                                          // The initial Map tilt (angle of incidence) in degrees from the viewport plane to the map plane. The only allowed values are 0 and 45.
        zoom: zoom ?? 8,                                  // The initial Map zoom level.
        zoomControl: true,                                // The enabled/disabled state of the Zoom control.
      });

      const state = getState(element);
      state.map = map;
      state.defaultMinZoom = map.get("minZoom") ?? 3;

      console.info("Google Map created", map);
    },

    /**
     * Enables field creation mode on the map.
     * In this mode, clicking the map will call back into .NET to add vertices.
     * @param {HTMLElement} element
     * @param {*} dotNetRef DotNetObjectReference
     */
    beginFieldCreation: function (element, dotNetRef) {
      const state = getState(element);
      if (!state.map) {
        console.error("beginFieldCreation: map not initialized");
        return;
      }

      state.isCreating = true;
      state.dotNetRef = dotNetRef ?? null;

      // Ensure we don't accumulate listeners between mode toggles.
      if (state.mapClickListener) {
        google.maps.event.removeListener(state.mapClickListener);
        state.mapClickListener = null;
      }

      state.mapClickListener = state.map.addListener("click", (e) => {
        if (!state.isCreating || !state.dotNetRef) return;
        if (!e || !e.latLng) return;

        state.dotNetRef.invokeMethodAsync("OnMapClick", e.latLng.lat(), e.latLng.lng());
      });
    },

    /**
     * Removes creation listeners and clears draft geometry.
     * @param {HTMLElement} element
     */
    cancelFieldCreation: function (element) {
      const state = getState(element);

      state.isCreating = false;
      state.dotNetRef = null;

      if (state.mapClickListener) {
        google.maps.event.removeListener(state.mapClickListener);
        state.mapClickListener = null;
      }

      clearDraft(state);
    },

    /**
     * Renders the draft field (markers + polyline) given the vertices coming from .NET.
     * @param {HTMLElement} element
     * @param {Array} vertices Array of {lat,lng} or {Lat,Lng}
     */
    renderDraftField: function (element, vertices, selectedIndex) {
      const state = getState(element);
      if (!state.map) {
        console.error("renderDraftField: map not initialized");
        return;
      }

      const pts = Array.isArray(vertices)
        ? vertices
            .map(toLatLngLiteral)
            .filter((p) => p && typeof p.lat === "number" && typeof p.lng === "number")
        : [];

      // Local copy used for smooth drag rendering on the client.
      state.localDraftVertices = pts.map((p) => ({ lat: p.lat, lng: p.lng }));

      // Full redraw is acceptable here (vertex counts are small).
      if (Array.isArray(state.draftMarkers)) {
        state.draftMarkers.forEach((m) => m && m.setMap && m.setMap(null));
      }
      state.draftMarkers = [];

      const color = getDraftColor(state.localDraftVertices.length);
      const sel = typeof selectedIndex === "number" ? selectedIndex : -1;
      state.selectedIndex = sel;

      state.localDraftVertices.forEach((p, index) => {
        const marker = new google.maps.Marker({
          map: state.map,
          position: p,
          draggable: true,
          clickable: true,
          icon: index === sel ? makeSelectedVertexIcon(color) : makeVertexIcon(color),
          zIndex: index === sel ? 999 : undefined,
        });

        marker.addListener("click", () => {
          if (!state.dotNetRef) return;
          state.dotNetRef.invokeMethodAsync("OnVertexSelect", index);
        });

        marker.addListener("rightclick", (e) => {
          // Prevent browser context menu.
          if (e?.domEvent?.preventDefault) e.domEvent.preventDefault();
          if (e?.domEvent?.stopPropagation) e.domEvent.stopPropagation();

          if (!state.dotNetRef) return;
          state.dotNetRef.invokeMethodAsync("OnVertexRightClick", index);
        });

        // Update the draft polyline continuously while dragging for a smooth UX.
        marker.addListener("drag", () => {
          const pos = marker.getPosition();
          if (!pos) return;
          state.localDraftVertices[index] = { lat: pos.lat(), lng: pos.lng() };
          renderDraftPolyline(state);
        });

        // Persist the final position server-side when the drag ends.
        marker.addListener("dragend", () => {
          const pos = marker.getPosition();
          if (!pos) return;
          if (!state.dotNetRef) return;
          state.dotNetRef.invokeMethodAsync("OnVertexDragEnd", index, pos.lat(), pos.lng());
        });

        state.draftMarkers.push(marker);
      });

      renderDraftPolyline(state);
    },

    /**
     * Draws the final field outline, fits the map to it, and applies zoom/pan restrictions.
     * @param {HTMLElement} element
     * @param {Array} vertices Array of {lat,lng} or {Lat,Lng}
     */
    renderFinalField: function (element, vertices) {
      const state = getState(element);
      if (!state.map) {
        console.error("renderFinalField: map not initialized");
        return;
      }

      // Ensure creation mode is disabled and draft geometry is removed.
      state.isCreating = false;
      state.dotNetRef = null;
      if (state.mapClickListener) {
        google.maps.event.removeListener(state.mapClickListener);
        state.mapClickListener = null;
      }
      clearDraft(state);

      const pts = Array.isArray(vertices)
        ? vertices
            .map(toLatLngLiteral)
            .filter((p) => p && typeof p.lat === "number" && typeof p.lng === "number")
        : [];

      if (pts.length < 3) {
        console.warn("renderFinalField: expected at least 3 vertices");
        return;
      }

      if (state.finalPolyline) {
        state.finalPolyline.setMap(null);
        state.finalPolyline = null;
      }

      const path = pts.concat([pts[0]]);
      state.finalPolyline = new google.maps.Polyline({
        map: state.map,
        path,
        clickable: false,
        strokeColor: "#52ff5b",
        strokeOpacity: 1,
        strokeWeight: 4,
      });

      const bounds = new google.maps.LatLngBounds();
      pts.forEach((p) => bounds.extend(p));

      // Reset any previous restrictions/listeners for the final state.
state.finalMinZoom = null;
      state.finalRestrictionBounds = null;
      state.isRecentering = false;
      state.map.setOptions({ restriction: null });

      // NOTE:
      // - The engine is Google Maps JS API (google.maps.Map).
      // - Fractional zoom is enabled in initializeMap (isFractionalZoomEnabled: true).
      //   We must avoid accidentally choosing a minZoom that is *tighter* than what fits.
      //
      // Fit with padding, then settle on a safe integer zoom that guarantees the polygon is fully visible.
      const fitPaddingPx = 30;

      // Ensure the Maps renderer has the latest container size (width: 100% responsive).
      window.requestAnimationFrame(() => {
        google.maps.event.trigger(state.map, "resize");
        state.map.fitBounds(bounds, fitPaddingPx);

        // After fit, confirm the polygon bounds are fully inside the viewport.
        // If not, zoom out until they are.
        (async () => {
          await waitForIdle(state.map);

          // Normalize to an integer zoom level to avoid any float->int coercion issues
          // that could make the minZoom slightly tighter than the fitted zoom.
          let z = state.map.getZoom();
          if (typeof z === "number") {
            const zInt = Math.floor(z);
            if (zInt !== z) {
              state.map.setZoom(zInt);
              await waitForIdle(state.map);
}
          }

          // If the polygon still doesn't fit (edge cases), zoom out further.
          for (let i = 0; i < 8; i++) {
            const viewport = state.map.getBounds();
            if (viewport && viewportContainsBounds(viewport, bounds)) break;

            const cur = state.map.getZoom();
            if (typeof cur !== "number") break;
            state.map.setZoom(cur - 1);
            await waitForIdle(state.map);
          }

          // The current zoom is the *minimum allowed* zoom-out.
          const minZoom = state.map.getZoom();
          if (typeof minZoom === "number") {
            state.finalMinZoom = minZoom;
          }

          // The pan restriction must be based EXACTLY on the viewport bounds resulting from this fit.
          const fitViewportBounds = state.map.getBounds();
          if (fitViewportBounds) {
            state.finalRestrictionBounds = fitViewportBounds;
          }

          state.map.setOptions({
            minZoom: typeof state.finalMinZoom === "number" ? state.finalMinZoom : state.map.get("minZoom"),
            restriction: state.finalRestrictionBounds
              ? { latLngBounds: state.finalRestrictionBounds, strictBounds: true }
              : null,
            scrollwheel: true,
            gestureHandling: "greedy",
          });

          // Apply once immediately to clamp center/zoom if needed.
          applyFinalPanLock(state);
        })();
      });

      // Keep pan lock synchronized with zoom changes.
      if (state.zoomListener) {
        google.maps.event.removeListener(state.zoomListener);
        state.zoomListener = null;
      }
      state.zoomListener = state.map.addListener("zoom_changed", () => applyFinalPanLock(state));

      // Prevent panning at minimum zoom while still allowing wheel zoom.
      if (state.centerListener) {
        google.maps.event.removeListener(state.centerListener);
        state.centerListener = null;
      }
      state.centerListener = state.map.addListener("center_changed", () => applyFinalPanLock(state));
    },

    /**
     * Removes the final field outline and resets zoom/pan restrictions.
     * @param {HTMLElement} element
     */
    clearFinalField: function (element) {
      const state = getState(element);
      if (!state.map) return;

      if (state.finalPolyline) {
        state.finalPolyline.setMap(null);
        state.finalPolyline = null;
      }

      state.finalMinZoom = null;
      state.finalRestrictionBounds = null;

      if (state.zoomListener) {
        google.maps.event.removeListener(state.zoomListener);
        state.zoomListener = null;
      }

      if (state.centerListener) {
        google.maps.event.removeListener(state.centerListener);
        state.centerListener = null;
      }

      state.isRecentering = false;

      state.map.setOptions({
        minZoom: state.defaultMinZoom ?? 3,
        draggable: true,
        scrollwheel: true,
        gestureHandling: "greedy",
        restriction: null,
      });
    }
  };
})();
