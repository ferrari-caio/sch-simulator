(function () {
  const SCRIPT_ID = "gmaps-script";
  const CALLBACK_NAME = "__gmapsOnLoad";
  const MAP_ID = "b148da6eb6229644eaa05434";

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

      console.info("Google Map created", map);
    }
  };
})();
