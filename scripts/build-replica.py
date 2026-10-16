"""Build local replica assets from the owner's measured and processed datasets.

Originals are read-only. Generated GLBs use local metres with Z up, matching the
survey, and record their origin explicitly. Run from the project root.
"""
import sys, json, struct, pathlib, io, math
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'analysis/python-packages'))
import cv2

SOURCE = pathlib.Path(r'C:\Users\SamDerTad\Desktop\CampusVision\Photogrammetry\processed')
OUT = ROOT / 'viewer/public/replica'
OUT.mkdir(parents=True, exist_ok=True)
Image.MAX_IMAGE_PIXELS = None
ORIGIN = np.array([340150., 2777800., 50.])
OFFSET = np.array([340303., 2777840., 0.])

def save_json(name, value):
    (OUT/name).write_text(json.dumps(value, indent=2), encoding='utf8')

def make_glb(name, positions, indices, uv=None, texture=None, colors=None, repeat=False):
    positions = np.asarray(positions, dtype='<f4')
    indices = np.asarray(indices, dtype='<u4').reshape(-1)
    document = {'asset': {'version':'2.0','generator':'UoD measured-surface pipeline'}, 'scene':0,
      'scenes':[{'nodes':[0]}], 'nodes':[{'mesh':0}], 'meshes':[{'primitives':[]}],
      'buffers':[{}], 'bufferViews':[], 'accessors':[], 'materials':[]}
    binary = bytearray()
    def view(data, target=None):
        while len(binary)%4: binary.append(0)
        offset=len(binary);binary.extend(data)
        entry={'buffer':0,'byteOffset':offset,'byteLength':len(data)}
        if target:entry['target']=target
        document['bufferViews'].append(entry);return len(document['bufferViews'])-1
    def accessor(array, typ, component, target, bounds=False, normalized=False):
        v=view(array.tobytes(),target);a={'bufferView':v,'componentType':component,'count':len(array),'type':typ}
        if bounds:a.update({'min':array.min(0).tolist(),'max':array.max(0).tolist()})
        if normalized:a['normalized']=True
        document['accessors'].append(a);return len(document['accessors'])-1
    attributes={'POSITION':accessor(positions,'VEC3',5126,34962,True)}
    if uv is not None:attributes['TEXCOORD_0']=accessor(np.asarray(uv,dtype='<f4'),'VEC2',5126,34962)
    if colors is not None:attributes['COLOR_0']=accessor(np.asarray(colors,dtype='uint8'),'VEC3',5121,34962,normalized=True)
    index_accessor=accessor(indices,'SCALAR',5125,34963)
    mat={'name':name,'doubleSided':True,'pbrMetallicRoughness':{'metallicFactor':0,'roughnessFactor':0.92}}
    if texture is not None:
        image_view=view(texture)
        document['images']=[{'bufferView':image_view,'mimeType':'image/jpeg'}]
        document['samplers']=[{'magFilter':9729,'minFilter':9987,'wrapS':10497 if repeat else 33071,'wrapT':10497 if repeat else 33071}]
        document['textures']=[{'source':0,'sampler':0}]
        mat['pbrMetallicRoughness']['baseColorTexture']={'index':0}
    document['materials']=[mat]
    document['meshes'][0]['primitives']=[{'attributes':attributes,'indices':index_accessor,'material':0}]
    document['buffers'][0]['byteLength']=len(binary)
    js=json.dumps(document,separators=(',',':')).encode()
    js+=b' '*((-len(js))%4);binary+=b'\0'*((-len(binary))%4)
    blob=struct.pack('<III',0x46546c67,2,12+8+len(js)+8+len(binary))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(binary),0x004e4942)+binary
    (OUT/name).write_bytes(blob)
    print(name, len(positions),'vertices',len(indices)//3,'triangles',round(len(blob)/1e6,2),'MB',flush=True)

def read_glb(path):
    data=path.read_bytes();jlen=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+jlen]);bin_start=20+jlen+8
    def get(i):
        a=doc['accessors'][i];v=doc['bufferViews'][a['bufferView']];dtype={5126:'<f4',5125:'<u4',5123:'<u2',5121:'u1'}[a['componentType']];n={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']]
        return np.frombuffer(data,dtype=dtype,count=a['count']*n,offset=bin_start+v.get('byteOffset',0)+a.get('byteOffset',0)).reshape(a['count'],n).copy()
    vertices=[];faces=[];offset=0
    for mesh in doc['meshes']:
        for primitive in mesh['primitives']:
            p=get(primitive['attributes']['POSITION']);idx=get(primitive['indices']).reshape(-1,3)
            vertices.append(p);faces.append(idx.astype('uint32')+offset);offset+=len(p)
    return np.concatenate(vertices),np.concatenate(faces)

def read_obj(path):
    vertices=[];faces=[]
    with path.open(encoding='utf8') as f:
        for line in f:
            if line.startswith('v '):vertices.append([float(x) for x in line.split()[1:4]])
            elif line.startswith('f '):
                face=[int(s.split('/')[0])-1 for s in line.split()[1:]]
                for i in range(1,len(face)-1):faces.append([face[0],face[i],face[i+1]])
    return np.array(vertices,dtype='float32'),np.array(faces,dtype='uint32')

def orthophoto(name):
    p=SOURCE/name/'odm_orthophoto/odm_orthophoto.tif';im=Image.open(p)
    tf=np.loadtxt(SOURCE/name/'odm_orthophoto/odm_orthophoto.tfw')
    meta={'xmin':float(tf[4]-tf[0]/2),'ymax':float(tf[5]-tf[3]/2),'pixelX':float(tf[0]),'pixelY':float(-tf[3]),'width':im.width,'height':im.height}
    im.thumbnail((4096,4096),Image.Resampling.LANCZOS)
    rgba=np.array(im);rgb=Image.fromarray(rgba[:,:,:3]);bio=io.BytesIO();rgb.save(bio,format='JPEG',quality=94,subsampling=0)
    key={'wide_angle_1':'wide','thermal_1':'thermal','zoom_1':'zoom'}[name]
    (OUT/(key+'.jpg')).write_bytes(bio.getvalue())
    meta.update({'image':key+'.jpg','textureWidth':im.width,'textureHeight':im.height})
    return meta,rgba,bio.getvalue()

print('Preparing aerial and capture imagery',flush=True)
aerial_geo=json.loads((ROOT/'analysis/aerial-georef.json').read_text())['extent']
aerial=Image.open(ROOT/'analysis/campus-aerial.jpg').convert('RGB')
aerial.save(OUT/'campus-aerial.jpg',quality=95)

# Full compound extent traced from the georeferenced aerial image. This is an
# illustrative campus extent, not a cadastral or survey-certified boundary.
trace=np.array([[300,420],[405,350],[635,375],[1245,1060],[1270,1185],[835,1475],[440,1450],[-80,680]],dtype=float)
boundary=np.column_stack([339750+trace[:,0]/1497*900,2778350.09765625-trace[:,1]/1664*1000.1953125])

metas={};rasters={};textures={}
for name in ['wide_angle_1','thermal_1','zoom_1']:
    metas[name],rasters[name],textures[name]=orthophoto(name)

detect=json.loads((ROOT/'analysis/east-panel-detection.json').read_text())
refmeta=metas['wide_angle_1'];pw,ph=detect['previewSize'];east_rows=[]
for rectangle in detect['rectangles'][:3]:
    p=np.array(rectangle['boxPixels']);world=np.column_stack([refmeta['xmin']+p[:,0]/pw*refmeta['width']*refmeta['pixelX'],refmeta['ymax']-p[:,1]/ph*refmeta['height']*refmeta['pixelY']])
    east_rows.append(world)

# Register visible/zoom images with matched physical features. Reject degenerate
# or implausible transforms, especially cross-spectrum feature false matches.
raw_registration=json.loads((ROOT/'analysis/image-registration.json').read_text())
horizontal={name:np.eye(3) for name in metas}
zm=np.array(raw_registration['zoom_1']['worldMatrix'])
if .98<np.linalg.det(zm[:2,:2])<1.02 and np.linalg.norm((zm@np.r_[OFFSET[:2],1])[:2]-OFFSET[:2])<3:
    horizontal['zoom_1']=zm

# Thermal registration is constrained by the long array's real edge pattern,
# rather than unreliable RGB-to-thermal keypoint matches.
box=east_rows[0];long=(box[1]-box[0]);length=np.linalg.norm(long);along=long/length;cross=(box[3]-box[0]);cross/=np.linalg.norm(cross)
anchor=box.mean(0);resolution=.2;shape=(220,2100)
def rectify(name):
    meta=metas[name];r=rasters[name];sx=(meta['width']*meta['pixelX'])/r.shape[1];sy=(meta['height']*meta['pixelY'])/r.shape[0]
    # Rectified image: columns across the three rows, rows along the array.
    xx,yy=np.meshgrid(np.arange(shape[0])*.2-22,np.arange(shape[1])*.2-210)
    wx=anchor[0]+cross[0]*xx+along[0]*yy;wy=anchor[1]+cross[1]*xx+along[1]*yy
    px=((wx-meta['xmin'])/sx).astype('float32');py=((meta['ymax']-wy)/sy).astype('float32')
    im=cv2.remap(r[:,:,:3],px,py,cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)
    return cv2.cvtColor(im,cv2.COLOR_RGB2GRAY).astype('float32')/255
w=rectify('wide_angle_1');t=rectify('thermal_1')
ww=cv2.GaussianBlur(w,(5,5),1.2);tt=cv2.GaussianBlur(t,(5,5),1.2)
warp=np.eye(2,3,dtype='float32');thermal_score=None
try:
    score,warp=cv2.findTransformECC(ww,tt,warp,cv2.MOTION_TRANSLATION,(cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT,150,1e-6),None,5)
    if np.linalg.norm(warp[:,2])<10 and score>.4:
        # ECC maps reference pixels to source pixels; translate source-world back.
        delta=-(cross*warp[0,2]+along*warp[1,2])*resolution
        horizontal['thermal_1'][:2,2]=delta
        thermal_score=float(score)
    print('Thermal edge registration',score,warp[:,2],flush=True)
except cv2.error as e:print('Thermal edge registration retained declared georeference:',e,flush=True)

vertical=json.loads((ROOT/'analysis/registration-initial.json').read_text())

print('Preparing shared eastern photogrammetry surface',flush=True)
p,tri=read_obj(SOURCE/'wide_angle_1/odm_texturing/odm_textured_model_geo.obj')
world=p.astype('float64')+OFFSET
coef=np.array(vertical['wide_angle_1']['verticalPlane'])
world[:,2]+=coef[0]*(world[:,0]-OFFSET[0])+coef[1]*(world[:,1]-OFFSET[1])+coef[2]
uv=np.column_stack([(world[:,0]-refmeta['xmin'])/(refmeta['width']*refmeta['pixelX']),(refmeta['ymax']-world[:,1])/(refmeta['height']*refmeta['pixelY'])])
raw=rasters['wide_angle_1'];ix=np.clip((uv[:,0]*raw.shape[1]).astype(int),0,raw.shape[1]-1);iy=np.clip((uv[:,1]*raw.shape[0]).astype(int),0,raw.shape[0]-1)
good=(raw[iy,ix,3]>200)&(world[:,2]>42)&(world[:,2]<90)&(uv[:,0]>=0)&(uv[:,0]<=1)&(uv[:,1]>=0)&(uv[:,1]<=1)
tri=tri[np.all(good[tri],axis=1)]
used,inverse=np.unique(tri,return_inverse=True)
make_glb('east-surface.glb',world[used]-ORIGIN,inverse,uv=uv[used],texture=textures['wide_angle_1'])
east_planes=[]
for row in east_rows:
    center=row.mean(0);axis=row[1]-row[0];length=np.linalg.norm(axis);axis/=length;side=row[3]-row[0];width=np.linalg.norm(side);side/=width
    delta=world[:,:2]-center;inside=(np.abs(delta@axis)<length/2)&(np.abs(delta@side)<width/2)&good
    pp=world[inside];XX=np.column_stack([pp[:,0]-ORIGIN[0],pp[:,1]-ORIGIN[1],np.ones(len(pp))]);zz=pp[:,2]-ORIGIN[2];keep=np.ones(len(pp),bool)
    for _ in range(5):
        plane=np.linalg.lstsq(XX[keep],zz[keep],rcond=None)[0];err=zz-XX@plane;keep=np.abs(err-np.median(err))<.3
    east_planes.append(plane.tolist())

print('Reconstructing measured building surfaces',flush=True)
sample=np.load(ROOT/'analysis/lidar-sample.npz');xyz=sample['xyz'];rgb=sample['rgb']
crop=(xyz[:,0]>339900)&(xyz[:,0]<340370)&(xyz[:,1]>2777470)&(xyz[:,1]<2777800)&(xyz[:,2]>43)&(xyz[:,2]<86)
pts=xyz[crop];cs=rgb[crop];res=.5;xmin,ymin=339900.,2777470.;nx,ny=941,661
ix=np.clip(((pts[:,0]-xmin)/res).astype(int),0,nx-1);iy=np.clip(((pts[:,1]-ymin)/res).astype(int),0,ny-1);ids=iy*nx+ix
height=np.full(nx*ny,-999,dtype='float32');counts=np.bincount(ids,minlength=nx*ny);np.maximum.at(height,ids,pts[:,2]);height=height.reshape(ny,nx)
valid=(counts.reshape(ny,nx)>=2)&(height>47)
near=ndimage.distance_transform_edt(~valid,return_distances=False,return_indices=True);filled=height[tuple(near)]
distance=ndimage.distance_transform_edt(~valid)*res
filled=ndimage.median_filter(filled,size=3)
base=49.0
# Model only measured elevated surfaces; broad ground comes from the aerial base.
structure=(filled>53.2)&(distance<2.5)
structure=ndimage.binary_closing(structure,iterations=2)
structure=ndimage.binary_fill_holes(structure & (filled>53.2))
# Keep small openings in the atrium/courtyards through measured low elevations.
structure &= filled>52.2
labels,nlabels=ndimage.label(structure);sizes=np.bincount(labels.ravel());structure &= sizes[labels]>30
yy,xx=np.mgrid[:ny,:nx];h=np.where(structure,filled,base)
vertices=np.column_stack([xmin+xx.ravel()*res,ymin+yy.ravel()*res,h.ravel()])
a=(yy[:-1,:-1]*nx+xx[:-1,:-1]).ravel();b=a+1;c=a+nx;d=c+1
faces=np.vstack([np.column_stack([a,b,c]),np.column_stack([b,d,c])])
mask=structure.ravel();keep=np.any(mask[faces],axis=1);faces=faces[keep]
used,inverse=np.unique(faces,return_inverse=True);v=vertices[used]
# Colour the reconstructed surfaces with actual scan RGB nearest their positions.
tree=cKDTree(pts);dist,nearest=tree.query(v,k=1,workers=-1);color=cs[nearest]
srgb=color.astype(float)/255;color=np.clip(np.where(srgb<=.04045,srgb/12.92,((srgb+.055)/1.055)**2.4)*255,0,255).astype('uint8')
make_glb('lidar-surfaces-reference.glb',v-ORIGIN,inverse,colors=color)

# A low-frequency ground fit gives the aerial plane the survey's actual gentle
# grade without interpreting vegetation or roofs as terrain.
ground=pts[(pts[:,2]>46)&(pts[:,2]<52)]
g=ground[::max(1,len(ground)//50000)]
X=np.column_stack([g[:,0]-ORIGIN[0],g[:,1]-ORIGIN[1],np.ones(len(g))]);gc=np.linalg.lstsq(X,g[:,2]-ORIGIN[2],rcond=None)[0]
for _ in range(4):
    residual=g[:,2]-ORIGIN[2]-X@gc;ok=np.abs(residual)<.65;gc=np.linalg.lstsq(X[ok],g[ok,2]-ORIGIN[2],rcond=None)[0]

print('Building continuous terrain across the entire compound',flush=True)
ex=aerial_geo;terrain_x=np.linspace(ex['xmin'],ex['xmax'],226);terrain_y=np.linspace(ex['ymin'],ex['ymax'],251)
tx,ty=np.meshgrid(terrain_x,terrain_y);terrain_z=gc[0]*(tx-ORIGIN[0])+gc[1]*(ty-ORIGIN[1])+gc[2]+ORIGIN[2]
dsm_image=Image.open(SOURCE/'wide_angle_1/odm_dem/dsm.tif');dsm=np.asarray(dsm_image)[::30,::30].copy();dsm[dsm<0]=np.inf
low=ndimage.minimum_filter(dsm,size=9);scale=dsm_image.tag_v2[33550];tie=dsm_image.tag_v2[33922]
px=((tx-tie[3])/(scale[0]*30)).astype(int);py=((tie[4]-ty)/(scale[1]*30)).astype(int)
inside=(px>=0)&(px<low.shape[1])&(py>=0)&(py<low.shape[0]);px=np.clip(px,0,low.shape[1]-1);py=np.clip(py,0,low.shape[0]-1)
source_h=low[py,px]+coef[0]*(tx-OFFSET[0])+coef[1]*(ty-OFFSET[1])+coef[2]
okay=inside&np.isfinite(source_h)&(source_h>35)&(source_h<80)
terrain_z=np.where(okay,np.minimum(terrain_z,source_h-.12),terrain_z)
terrain_z=ndimage.gaussian_filter(terrain_z,1.0)
tv=np.column_stack([tx.ravel(),ty.ravel(),terrain_z.ravel()]);tuv=np.column_stack([(tx.ravel()-ex['xmin'])/(ex['xmax']-ex['xmin']),(ex['ymax']-ty.ravel())/(ex['ymax']-ex['ymin'])])
gy,gx=np.mgrid[:250,:225];ia=(gy*226+gx).ravel();tf=np.vstack([np.column_stack([ia,ia+1,ia+226]),np.column_stack([ia+1,ia+227,ia+226])])
make_glb('terrain.glb',tv-ORIGIN,tf,uv=tuv,texture=(OUT/'campus-aerial.jpg').read_bytes())

print('Constructing smooth architectural roof forms and facades',flush=True)
roof_vertices=[];roof_faces=[];facade_vertices=[];facade_faces=[];facade_uv=[];canopy_footprints=[];building_evidence=[]
def pixel_to_world(pixel):
    pixel=np.asarray(pixel,float)
    return np.column_stack([339750+pixel[:,0]/1497*900,2778350.09765625-pixel[:,1]/1664*1000.1953125])
def select_polygon(points,poly):
    xx=points[:,0];yy=points[:,1];inside=np.zeros(len(points),bool)
    for i in range(len(poly)):
        p1=poly[i];p2=poly[i-1]
        inside^=((p1[1]>yy)!=(p2[1]>yy))&(xx<(p2[0]-p1[0])*(yy-p1[1])/(p2[1]-p1[1]+1e-20)+p1[0])
    return inside
def roof_level(poly,kind='building'):
    center=poly.mean(0);ground=gc[0]*(center[0]-ORIGIN[0])+gc[1]*(center[1]-ORIGIN[1])+gc[2]+ORIGIN[2]
    selected=pts[select_polygon(pts,poly)]
    high=selected[selected[:,2]>ground+6,2]
    level=float(np.quantile(high,.965)) if len(high)>150 else ground+15
    if kind in ['canopy','service']:level=ground+3.25
    building_evidence.append({'kind':kind,'footprint':poly.tolist(),'roofZ':round(level,3),'supportingLidarSamples':len(high),'elevationMethod':'96.5th percentile of elevated LiDAR samples; architectural surface fitted to aerial outline' if kind!='canopy' else 'modelled parking canopy height'})
    return level
def wall_edges(poly,z):
    for i in range(len(poly)):
        p1=poly[i];p2=poly[(i+1)%len(poly)];length=np.linalg.norm(p2-p1)
        b1=gc[0]*(p1[0]-ORIGIN[0])+gc[1]*(p1[1]-ORIGIN[1])+gc[2]+ORIGIN[2]
        b2=gc[0]*(p2[0]-ORIGIN[0])+gc[1]*(p2[1]-ORIGIN[1])+gc[2]+ORIGIN[2]
        offset=len(facade_vertices)
        facade_vertices.extend([[*p1,b1],[*p2,b2],[*p1,z],[*p2,z]])
        facade_uv.extend([[0,0],[length/3.2,0],[0,(z-b1)/3.8],[length/3.2,(z-b2)/3.8]])
        facade_faces.extend([[offset,offset+1,offset+2],[offset+1,offset+3,offset+2]])
def sector(name,inner,outer,start,end):
    angles=np.linspace(np.deg2rad(start),np.deg2rad(end),max(20,int((end-start)/2)+1));radii=np.linspace(inner,outer,9)
    aa,rr=np.meshgrid(angles,radii,indexing='ij');pixel=np.column_stack([674+rr.ravel()*np.cos(aa.ravel()),1095-rr.ravel()*np.sin(aa.ravel())]);poly=np.vstack([pixel[:9],pixel[8::9],pixel[-9:][::-1],pixel[::9][::-1]])
    worldxy=pixel_to_world(pixel);boundaryxy=pixel_to_world(poly);z=roof_level(boundaryxy)
    # Smooth, shallow roof curvature; actual measured elevations set the roof datum.
    height=z+.65*np.sin((rr.ravel()-inner)/(outer-inner)*np.pi)
    offset=len(roof_vertices);roof_vertices.extend(np.column_stack([worldxy,height]).tolist())
    for i in range(len(angles)-1):
        for j in range(8):
            q=offset+i*9+j;roof_faces.extend([[q,q+9,q+1],[q+1,q+9,q+10]])
    wall_edges(boundaryxy,z)
def polygon_roof(name,pixel,kind='building'):
    xy=pixel_to_world(pixel);z=roof_level(xy,kind);offset=len(roof_vertices)
    roof_vertices.extend(np.column_stack([xy,np.full(len(xy),z)]).tolist())
    for i in range(1,len(xy)-1):roof_faces.append([offset,offset+i,offset+i+1])
    if kind!='canopy':wall_edges(xy,z)
    else:canopy_footprints.append({'points':xy.tolist(),'z':z})
sector('Academic courtyard ring',63,105,170,337)
sector('Conference glazed ring',64,91,345,465)
sector('Eastern academic wing',94,268,336,345)
sector('Middle academic wing',105,267,317,330)
sector('Southern academic wing',108,265,276,306)
polygon_roof('Western academic spine',[[535,1090],[565,1098],[572,1135],[610,1176],[599,1197],[559,1155],[541,1119]])
polygon_roof('Courtyard connection',[[522,1075],[631,1089],[628,1106],[520,1092]])
polygon_roof('Campus utility building',[[630,900],[648,897],[655,931],[637,934]],'service')
polygon_roof('Entrance building',[[350,993],[373,985],[389,1007],[366,1016]],'service')
for poly in [
 [[452,1073],[475,1070],[488,1126],[466,1132]],
 [[477,1148],[495,1139],[524,1187],[504,1199]],
 [[510,1204],[528,1193],[566,1225],[552,1242]],
 [[303,1056],[378,1042],[381,1053],[306,1067]],
 [[307,1073],[382,1059],[385,1070],[310,1084]],
 [[311,1090],[386,1076],[389,1087],[314,1101]],
]:polygon_roof('Covered parking',poly,'canopy')
roof_vertices=np.array(roof_vertices);roofuv=np.column_stack([(roof_vertices[:,0]-ex['xmin'])/(ex['xmax']-ex['xmin']),(ex['ymax']-roof_vertices[:,1])/(ex['ymax']-ex['ymin'])])
make_glb('campus-surfaces.glb',roof_vertices-ORIGIN,roof_faces,uv=roofuv,texture=(OUT/'campus-aerial.jpg').read_bytes())
# Facade details are modelled, not claimed as captured photography.
from PIL import ImageDraw
facade_image=Image.new('RGB',(256,256),(207,205,190));draw=ImageDraw.Draw(facade_image)
draw.rectangle((22,23,234,211),fill=(65,86,92));draw.rectangle((24,25,231,207),fill=(68,91,99))
draw.rectangle((26,28,229,67),fill=(90,111,119));draw.line((128,25,128,210),fill=(177,185,179),width=4);draw.line((24,127,232,127),fill=(172,182,177),width=3)
draw.rectangle((18,211,238,218),fill=(178,179,164));draw.line((0,246,256,246),fill=(181,183,169),width=3)
bio=io.BytesIO();facade_image.save(bio,format='JPEG',quality=95)
make_glb('campus-facades.glb',np.array(facade_vertices)-ORIGIN,facade_faces,uv=facade_uv,texture=bio.getvalue(),repeat=True)

# Infer tree positions from actual aerial crown patches. Measured heights are
# used where LiDAR covers them, otherwise a clearly documented landscape model.
arr=np.array(aerial);r,gcim,b=arr[:,:,0].astype(float),arr[:,:,1].astype(float),arr[:,:,2].astype(float)
green=((gcim>r*1.06)&(gcim>b*1.06)&(gcim>32)&(gcim<170)).astype('uint8')
green=cv2.morphologyEx(green,cv2.MORPH_OPEN,np.ones((3,3),'uint8'))
green=cv2.morphologyEx(green,cv2.MORPH_CLOSE,np.ones((4,4),'uint8'))
num,lab,stats,centroids=cv2.connectedComponentsWithStats(green)
parcelpx=np.column_stack([(boundary[:,0]-ex['xmin'])/(ex['xmax']-ex['xmin'])*arr.shape[1],(ex['ymax']-boundary[:,1])/(ex['ymax']-ex['ymin'])*arr.shape[0]]).astype('float32')
trees=[]
for idx in range(1,num):
    area=stats[idx,cv2.CC_STAT_AREA];px,py=centroids[idx]
    if area<7 or area>600 or cv2.pointPolygonTest(parcelpx,(float(px),float(py)),False)<0:continue
    x=ex['xmin']+px/arr.shape[1]*(ex['xmax']-ex['xmin']);y=ex['ymax']-py/arr.shape[0]*(ex['ymax']-ex['ymin'])
    # No trees on the building footprint or solar strips.
    if any(cv2.pointPolygonTest(np.array(e['footprint'],dtype='float32'),(float(x),float(y)),False)>=0 for e in building_evidence):continue
    radius=max(1.1,min(4.2,math.sqrt(area/math.pi)*900/arr.shape[1]))
    z=float(gc[0]*(x-ORIGIN[0])+gc[1]*(y-ORIGIN[1])+gc[2])
    trees.append([round(x-ORIGIN[0],3),round(y-ORIGIN[1],3),round(z,3),round(radius,3)])

# South cluster is a separate installation visible in the aerial, with no W/T/Z
# capture coverage. Trace three parallel rows in aerial pixel coordinates.
south_box=np.array(json.loads((ROOT/'analysis/south-detection.json').read_text())[1]['boxPixels'])
start=south_box[1];end=south_box[2];across=south_box[0]-start
south_rows_px=[]
for lo,hi in [(0,.27),(.365,.635),(.73,1.)]:
    south_rows_px.append([start+across*lo,end+across*lo,end+across*hi,start+across*hi])
south=[]
for row in south_rows_px:
    pp=np.array(row,float);south.append(np.column_stack([339750+pp[:,0]/1497*900,2778350.09765625-pp[:,1]/1664*1000.1953125]).tolist())

registration={}
for name in metas:
    A=horizontal[name];local=np.eye(3);local[:2,:2]=A[:2,:2];local[:2,2]=(A@np.r_[ORIGIN[:2],1])[:2]-ORIGIN[:2]
    registration[name]={'sourceToReferenceLocal':local.tolist(),'vertical':vertical[name], 'texture':metas[name]}

save_json('site.json',{
 'origin':ORIGIN.tolist(),'crs':'WGS 84 / UTM 40N','verticalReference':'LiDAR local reference; vertical datum unverified',
 'aerial':{'image':'campus-aerial.jpg','extent':aerial_geo,'attribution':'Esri World Imagery · Esri, Maxar, Earthstar Geographics and the GIS User Community','source':'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'},
 'boundary':boundary.tolist(),'boundaryMethod':'Image-traced compound extent; not a cadastral boundary',
 'groundPlane':gc.tolist(),'terrain':{'xmin':float(terrain_x[0]-ORIGIN[0]),'ymin':float(terrain_y[0]-ORIGIN[1]),'stepX':float(terrain_x[1]-terrain_x[0]),'stepY':float(terrain_y[1]-terrain_y[0]),'width':226,'height':251,'heights':np.round(terrain_z-ORIGIN[2],3).ravel().tolist()},'trees':trees,'eastRows':[r.tolist() for r in east_rows],'eastRowPlanes':east_planes,'southRows':south,
 'registration':registration,'thermalEdgeCorrelation':thermal_score,'coveredParking':canopy_footprints,'buildingEvidence':building_evidence,
 'bookmarks':{'compound':[0,15,0],'building':[30,-165,8],'east':[float(anchor[0]-ORIGIN[0]),float(anchor[1]-ORIGIN[1]),2],'south':[float(np.array(south).mean((0,1))[0]-ORIGIN[0]),float(np.array(south).mean((0,1))[1]-ORIGIN[1]),2]},
 'notes':{'building':'Aerial-traced architectural forms with LiDAR-constrained roof elevations; facade and window details are modelled.','landscape':'Image-derived crown positions with modelled tree forms; broad ground fitted to LiDAR.','east':'One corrected wide-camera surface; W/T/Z textures register onto identical geometry.','south':'Image-traced array footprint with modelled modules; no thermal/zoom captures supplied for this cluster.'}
})
save_json('provenance.json',{
 'campus-aerial.jpg':{'origin':'Esri World Imagery georeferenced export','requestExtent':aerial_geo,'source':'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'},
 'wide.jpg':{'origin':str(SOURCE/'wide_angle_1/odm_orthophoto/odm_orthophoto.tif')},
 'thermal.jpg':{'origin':str(SOURCE/'thermal_1/odm_orthophoto/odm_orthophoto.tif'),'note':'Rendered thermal palette; no calibrated temperature values are implied.'},
 'zoom.jpg':{'origin':str(SOURCE/'zoom_1/odm_orthophoto/odm_orthophoto.tif')},
 'campus-surfaces.glb':{'origin':'20261008121946091.las and Esri georeferenced aerial imagery','method':'Aerial-traced architectural outlines; roof elevations constrained by elevated LiDAR samples; smooth fitted roofs'},
 'campus-facades.glb':{'origin':'Aerial-traced roof outlines and LiDAR-constrained heights','method':'Modelled facades; procedural window and concrete texture authored by build-replica.py, not captured photography'},
 'terrain.glb':{'origin':'LiDAR ground fit, corrected wide-camera DSM and Esri World Imagery','method':'Continuous terrain with georeferenced aerial colour'},
 'east-surface.glb':{'origin':str(SOURCE/'wide_angle_1/odm_texturing/odm_textured_model_geo.glb'),'method':'Preserve source triangles; remove invalid fragments; fit vertical correction to LiDAR; orthographic source texture'}
})
print('Completed. Trees:',len(trees),'ground:',gc,'thermal registration:',thermal_score,flush=True)
